import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { homedir } from "node:os";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  configPatchSchema,
  createAutomationSchema,
  createSessionSchema,
  customThemeSchema,
  enqueueJobSchema,
  learnSkillSchema,
  mcpServerSchema,
  mcpUsageQuerySchema,
  mediaGenRequestSchema,
  mediaUsageQuerySchema,
  permissionReplySchema,
  promptPayloadSchema,
  putAccountSchema,
  putAssetTagsSchema,
  putNotesSchema,
  putPlanSchema,
  putTodosSchema,
  oauthStartSchema,
  oauthSubmitSchema,
  customProviderSchema,
  putAgentSchema,
  putSkillFileSchema,
  putSkillSchema,
  putToolSchema,
  questionRejectSchema,
  questionReplySchema,
  registeredRoots,
  renameSessionSchema,
  revertSessionSchema,
  forkSessionSchema,
  setSessionAgentSchema,
  setSessionModelSchema,
  skillFilePathSchema,
  skillUsageQuerySchema,
  updateAutomationSchema,
  usageAnalyticsQuerySchema,
  type AttachmentRef,
  type InputId,
  type MessageId,
  type JobId,
  type SessionId,
  type SessionsCursor,
  type MediaGalleryCursor,
} from "@bai/shared";
import { decodeCursor, decodeHistoryCursor, encodeCursor, webSearchStatus, type HistoryCursor } from "@bai/core";
import { bearerAuth } from "./auth";
import type { ApiDeps } from "./deps";
import { completePath, createFolder, ensureRegisteredRoot, FsError, findFiles, FS_UPLOAD_MAX_BYTES, listDir, readFile, statPath, writeFile } from "./fs";
import { runDurableStream, runFirehose } from "./sse";
import { shellAvailable } from "./shell";
import { staticHandler } from "./static";
import { deleteCustomTheme, listCustomThemes, saveCustomTheme } from "./themes";

/**
 * The /api router. Built as ONE chained expression on purpose — Hono only
 * carries route type inference through the chain, and the typed client
 * (`hc<ApiType>`) depends on it. Handlers stay thin: decode → call core →
 * encode.
 */
function buildApi(deps: ApiDeps) {
  return new Hono()
    .get("/health", (c) => c.json({ ok: true, version: deps.version }))

    // --- sessions ---
    // Paged list. Optional filters (web: chat section lists workbench=chat;
    // the workspace view lists cwd=<workspace path>); `q` = title/id
    // substring; `roots=1` excludes child (subagent) sessions. Page with
    // `?before=<cursor>` (keyset on updatedAt+id) — the first page may also
    // use the legacy `offset`, and still returns a cursor to continue.
    .get("/session", (c) => {
      const rawLimit = Number(c.req.query("limit") ?? "50");
      // Offset/legacy callers (e.g. the workspace archive count) may ask for
      // more than a UI page; cursor pages are further capped in listPage.
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 1000) : 50;
      const offset = Math.max(0, Number(c.req.query("offset") ?? "0") || 0);
      const workbench = c.req.query("workbench");
      const cwd = c.req.query("cwd");
      const q = c.req.query("q");
      const roots = c.req.query("roots") === "1" || c.req.query("roots") === "true";
      const filters = {
        ...(workbench !== undefined && workbench.length > 0 ? { workbench } : {}),
        ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
        ...(q !== undefined && q.length > 0 ? { q } : {}),
        ...(roots ? { roots: true } : {}),
      };
      const rawBefore = c.req.query("before");
      if (rawBefore !== undefined && rawBefore.length > 0) {
        const cursor = decodeCursor<SessionsCursor>(rawBefore);
        if (
          cursor === undefined ||
          typeof cursor.updatedAt !== "string" ||
          typeof cursor.id !== "string"
        ) {
          return c.json({ error: "invalid before cursor" }, 400);
        }
        return c.json(deps.core.listSessionsPage(limit, cursor, filters));
      }
      const rows = deps.core.listSessions(limit + 1, offset, filters);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const oldest = page[page.length - 1];
      return c.json({
        sessions: page,
        hasMore,
        total: deps.core.countSessions(filters),
        ...(hasMore && oldest !== undefined
          ? { nextCursor: encodeCursor({ updatedAt: oldest.updatedAt, id: oldest.id } satisfies SessionsCursor) }
          : {}),
      });
    })
    .post("/session", zValidator("json", createSessionSchema), (c) => {
      const body = c.req.valid("json");
      const session = deps.core.createSession(body);
      return c.json({ session }, 201);
    })
    .get("/session/:id", (c) => {
      const session = deps.core.getSession(c.req.param("id") as SessionId);
      if (session === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ session });
    })
    .get(
      "/session/:id/message",
      zValidator("query", z.object({ limit: z.string().optional(), before: z.string().optional() })),
      (c) => {
        const id = c.req.param("id") as SessionId;
        if (deps.core.getSession(id) === undefined) return c.json({ error: "not_found" }, 404);
        // Snapshot + cursor: clients resume the durable stream from afterSeq,
        // so replay never duplicates what this response already contains.
        // Paged: ?limit=N (default 100, max 500) + ?before=<opaque cursor>
        // returns the newest N (or the N older than the cursor) + hasMore.
        const query = c.req.valid("query");
        const rawLimit = query.limit;
        const rawBefore = query.before;
        const limit =
          rawLimit === undefined || rawLimit.length === 0
            ? 100
            : Math.max(1, Math.min(Number(rawLimit) || 100, 500));
        let before: HistoryCursor | undefined;
        if (rawBefore !== undefined && rawBefore.length > 0) {
          before = decodeHistoryCursor(rawBefore);
          if (before === undefined) return c.json({ error: "invalid before cursor" }, 400);
        }
        return c.json(deps.core.sessionSnapshot(id, { limit, ...(before !== undefined ? { before } : {}) }));
      },
    )
    .post("/session/:id/message", zValidator("json", promptPayloadSchema), async (c) => {
      const id = c.req.param("id") as SessionId;
      const body = c.req.valid("json");
      try {
        // Fail closed before admitting: a known model that cannot accept an
        // attachment type rejects the whole send with a clear message.
        const attachments = (body.attachments ?? []) as AttachmentRef[];
        await deps.core.assertAttachmentsSupported(id, attachments);
        const input = deps.core.submitPrompt(id, {
          text: body.text,
          ...(body.queue !== undefined ? { queue: body.queue } : {}),
          ...(body.attachments !== undefined ? { attachments } : {}),
        });
        return c.json({ input }, 202);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Unknown session")) return c.json({ error: "not_found" }, 404);
        return c.json({ error: message }, 400);
      }
    })
    .post("/session/:id/interrupt", (c) => {
      const id = c.req.param("id") as SessionId;
      deps.core.interrupt(id);
      return c.json({ ok: true });
    })
    // --- pending inputs (message queue) ---
    // Send-now flips a queued input to steer semantics (promotes at the
    // next safe boundary — immediately when idle, mid-run otherwise);
    // cancel drops it. Both 409 on a non-pending input (already promoted
    // or cancelled — the surfaces' node is stale).
    .post("/session/:id/input/:inputId/send", (c) => {
      const id = c.req.param("id") as SessionId;
      const inputId = c.req.param("inputId") as InputId;
      try {
        const input = deps.core.sendInputNow(id, inputId);
        return c.json({ input });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Unknown session")) return c.json({ error: "not_found" }, 404);
        if (message.startsWith("Unknown or non-pending input")) return c.json({ error: message }, 409);
        return c.json({ error: message }, 400);
      }
    })
    .post("/session/:id/input/:inputId/cancel", (c) => {
      const id = c.req.param("id") as SessionId;
      const inputId = c.req.param("inputId") as InputId;
      try {
        const input = deps.core.cancelInput(id, inputId);
        return c.json({ input });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Unknown session")) return c.json({ error: "not_found" }, 404);
        if (message.startsWith("Unknown or non-pending input")) return c.json({ error: message }, 409);
        return c.json({ error: message }, 400);
      }
    })
    // Durable per-session stream: replay-then-live with seq cursor.
    .get("/session/:id/event", (c) => {
      const id = c.req.param("id");
      const after = Number(c.req.query("after") ?? "0") || 0;
      return streamSSE(c, (stream) =>
        runDurableStream(stream, { sessionId: id, after, bus: deps.bus, log: deps.log }),
      );
    })

    // --- global firehose ---
    .get("/event", (c) =>
      streamSSE(c, (stream) => runFirehose(stream, { bus: deps.bus, version: deps.version })),
    )

    // --- shell (web terminal) ---
    // Capability probe for the UI's availability check. The terminal itself
    // rides the /api/shell/ws WebSocket upgrade, intercepted in the mode's
    // fetch wrapper (cli/modes/web.ts) — Bun's server.upgrade() is only
    // reachable there. Auth for the upgrade: loopback bypasses; beyond
    // loopback the pairing token is required as ?token= (shell.ts).
    .get("/shell", (c) => c.json({ ok: true, available: shellAvailable() }))

    // --- permissions ---
    // Global pending-ask index (any session): the surfaces' indicator seed
    // (TUI sessions list, web nav badge). Live updates ride the firehose
    // (permission.asked/replied, question.asked/replied/rejected); this is
    // the authoritative re-seed on connect/reconnect (the firehose is
    // live-only, so events missed during drops heal here).
    .get("/permission", (c) => c.json(deps.core.pendingAsks()))
    .post("/permission/:id/reply", zValidator("json", permissionReplySchema), (c) => {
      const body = c.req.valid("json");
      // scope + message MUST reach core: "always" persists the session
      // approval, message is the user's reject feedback to the model.
      const request = deps.core.replyPermission(c.req.param("id"), body.status, body.scope, body.message);
      if (request === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ request });
    })

    // --- questions (agent → user asks; first reply wins) ---
    .post("/question/:id/reply", zValidator("json", questionReplySchema), (c) => {
      const body = c.req.valid("json");
      if (!deps.core.replyQuestion(c.req.param("id"), body.answers)) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ ok: true });
    })
    .post("/question/:id/reject", zValidator("json", questionRejectSchema), (c) => {
      const body = c.req.valid("json");
      if (!deps.core.rejectQuestion(c.req.param("id"), body.message)) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ ok: true });
    })

    // --- config ---
    .get("/config", (c) => c.json({ config: deps.configStore.get() }))
    .put("/config", zValidator("json", configPatchSchema), (c) => {
      const patch = c.req.valid("json");
      const config = deps.configStore.update(patch);
      // No emitLive here — the ConfigStore's onChange is the single
      // broadcast point (bus + firehose), covering own writes, agent-tool
      // writes, and external file edits alike.
      return c.json({ config });
    })

    // --- web search (read-only provider/key status for the settings UI) ---
    .get("/web-search/status", (c) => c.json(webSearchStatus(deps.configStore.get())))

    // --- MCP servers (external integrations) ---
    .get("/mcp/servers", (c) => c.json({ servers: deps.core.mcpServers() }))
    // Registered before the parameterized server routes so "usage" is never
    // captured as a server name (the /skill/usage precedent).
    .get("/mcp/usage", zValidator("query", mcpUsageQuerySchema), (c) => {
      return c.json(deps.store.mcpUsage.analytics(c.req.valid("query")));
    })
    .get("/mcp/server/:name", (c) => {
      const server = deps.core.mcpServer(c.req.param("name"));
      if (server === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ server });
    })
    .get("/mcp/server/:name/usage", (c) => {
      // Analytics, not config: a removed server keeps its usage history, so
      // an unknown name returns zeroed totals rather than a 404.
      return c.json({ usage: deps.store.mcpUsage.forServer(c.req.param("name")) });
    })
    .get("/mcp/catalog", (c) => c.json({ catalog: deps.core.mcpCatalog() }))
    .put("/mcp/server/:name", zValidator("json", z.object({ config: mcpServerSchema })), async (c) => {
      try {
        await deps.core.mcpPut(c.req.param("name"), c.req.valid("json").config);
        deps.core.emitLive("mcp.updated", {});
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .delete("/mcp/server/:name", async (c) => {
      try {
        const removed = await deps.core.mcpRemove(c.req.param("name"));
        deps.core.emitLive("mcp.updated", {});
        return c.json({ ok: true, removed });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/mcp/server/:name/enabled", zValidator("json", z.object({ enabled: z.boolean() })), async (c) => {
      try {
        await deps.core.mcpSetEnabled(c.req.param("name"), c.req.valid("json").enabled);
        deps.core.emitLive("mcp.updated", {});
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/mcp/server/:name/reconnect", async (c) => {
      try {
        await deps.core.mcpReconnect();
        deps.core.emitLive("mcp.updated", {});
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/mcp/server/:name/auth", async (c) => {
      try {
        const url = await deps.core.mcpStartAuth(c.req.param("name"));
        return c.json({ url });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/mcp/server/:name/auth/finish", zValidator("json", z.object({ code: z.string().min(1) })), async (c) => {
      try {
        await deps.core.mcpFinishAuth(c.req.param("name"), c.req.valid("json").code);
        deps.core.emitLive("mcp.updated", {});
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/mcp/catalog/:name/install", async (c) => {
      try {
        const url = await deps.core.mcpInstall(c.req.param("name"));
        deps.core.emitLive("mcp.updated", {});
        return c.json({ ok: true, ...(url !== undefined ? { url } : {}) });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })

    // --- workspaces (webui Active | Archived) ---
    // Remove = unregister + archive the workspace's sessions (the webui's
    // hide mechanism; the folder on disk is never touched). Restore is the
    // inverse. Both broadcast config.updated via the ConfigStore's onChange.
    .post("/workspace/remove", zValidator("json", z.object({ path: z.string().min(1).max(1024) })), (c) => {
      try {
        return c.json(deps.core.removeWorkspace(c.req.valid("json").path), 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/workspace/restore", zValidator("json", z.object({ path: z.string().min(1).max(1024) })), (c) => {
      try {
        return c.json(deps.core.restoreWorkspace(c.req.valid("json").path), 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })

    // --- custom themes (~/.config/bai/themes/*.json; the web editor writes here) ---
    .get("/theme/custom", (c) => c.json({ themes: listCustomThemes(deps.themesDir) }))
    .put("/theme/custom/:id", zValidator("json", customThemeSchema), (c) => {
      try {
        const theme = saveCustomTheme(deps.themesDir, c.req.param("id"), c.req.valid("json"));
        return c.json({ theme }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .delete("/theme/custom/:id", (c) => {
      if (!deleteCustomTheme(deps.themesDir, c.req.param("id"))) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ ok: true });
    })

    // --- agents (file-defined, hot-reloaded; routes write the .md files) ---
    .get("/agent", (c) => c.json({ agents: deps.core.listAgents() }))
    .get("/agent/:name", (c) => {
      const agent = deps.core.getAgent(c.req.param("name"));
      if (agent === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ agent });
    })
    .put("/agent/:name", zValidator("json", putAgentSchema), (c) => {
      const name = c.req.param("name");
      try {
        const agent = deps.core.putAgent(name, c.req.valid("json"));
        deps.core.emitLive("agents.updated", {});
        return c.json({ agent }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .delete("/agent/:name", (c) => {
      const name = c.req.param("name");
      try {
        if (!deps.core.deleteAgent(name)) return c.json({ error: "not_found" }, 404);
        deps.core.emitLive("agents.updated", {});
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })

    // --- skills (file-defined, hot-reloaded; routes write the SKILL.md files) ---
    // Paged browse for UI when `limit` is present; no limit → the full list
    // (legacy/agent-adjacent callers). The agent's skills index always reads
    // core `listSkills()` directly, never this route.
    .get("/skill", (c) => {
      const rawLimit = c.req.query("limit");
      if (rawLimit === undefined || rawLimit.length === 0) {
        const skills = deps.core.listSkills();
        return c.json({ skills, hasMore: false, total: skills.length });
      }
      const limit = Math.max(1, Math.min(Math.floor(Number(rawLimit) || 50), 200));
      const offset = Math.max(0, Number(c.req.query("offset") ?? "0") || 0);
      const q = c.req.query("q");
      return c.json(deps.core.listSkillsPage(limit, offset, q));
    })
    // Registered BEFORE /skill/:name so "usage" is never captured as a name.
    .get("/skill/usage", zValidator("query", skillUsageQuerySchema), (c) => {
      return c.json(deps.core.skillUsageAnalytics(c.req.valid("query")));
    })
    // Learn (hermes /learn parity, no slash command): spawn a visible learn
    // session whose first turn is the standards-guided learn request.
    .post("/skill/learn", zValidator("json", learnSkillSchema), (c) => {
      try {
        const session = deps.core.learnSkill(c.req.valid("json"));
        return c.json({ session }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .get("/skill/:name", (c) => {
      const skill = deps.core.getSkill(c.req.param("name"));
      if (skill === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ skill, usage: deps.core.skillUsage(skill.name) });
    })
    .put("/skill/:name", zValidator("json", putSkillSchema), (c) => {
      const name = c.req.param("name");
      try {
        const skill = deps.core.putSkill(name, c.req.valid("json"));
        deps.core.emitLive("skills.updated", {});
        return c.json({ skill }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .delete("/skill/:name", (c) => {
      const name = c.req.param("name");
      try {
        if (!deps.core.deleteSkill(name)) return c.json({ error: "not_found" }, 404);
        deps.core.emitLive("skills.updated", {});
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    // Linked supporting files (references/templates/scripts/assets) — the
    // path rides the query string so /skill/:name stays the only param route.
    .get("/skill/:name/file", zValidator("query", skillFilePathSchema), (c) => {
      try {
        const content = deps.core.skillFile(c.req.param("name"), c.req.valid("query").path);
        return c.json({ content });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, message.includes("Unknown skill") ? 404 : 400);
      }
    })
    .put("/skill/:name/file", zValidator("query", skillFilePathSchema), zValidator("json", putSkillFileSchema), (c) => {
      try {
        deps.core.putSkillFile(c.req.param("name"), c.req.valid("query").path, c.req.valid("json").content);
        deps.core.emitLive("skills.updated", {});
        return c.json({ ok: true }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .delete("/skill/:name/file", zValidator("query", skillFilePathSchema), (c) => {
      try {
        deps.core.deleteSkillFile(c.req.param("name"), c.req.valid("query").path);
        deps.core.emitLive("skills.updated", {});
        return c.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, message.includes("Unknown skill") ? 404 : 400);
      }
    })

    // --- tools (built-ins + hot-reloaded custom tool files) ---
    .get("/tool", (c) => c.json({ tools: deps.core.listTools() }))
    .get("/tool/:name", (c) => {
      try {
        return c.json({ code: deps.core.getToolCode(c.req.param("name")) });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
      }
    })
    .put("/tool/:name", zValidator("json", putToolSchema), async (c) => {
      const name = c.req.param("name");
      try {
        const result = await deps.core.putTool(name, c.req.valid("json").code);
        deps.core.emitLive("tools.updated", {});
        return c.json(result, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .delete("/tool/:name", async (c) => {
      const name = c.req.param("name");
      try {
        if (!(await deps.core.deleteTool(name))) return c.json({ error: "not_found" }, 404);
        deps.core.emitLive("tools.updated", {});
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })

    // --- filesystem (read-only; powers the web file tree) ---
    // Listing is scoped to REGISTERED workspaces (config.workspaces): the
    // tree can browse workspaces, never arbitrary machine paths. One flat
    // directory per call; `path` must resolve (realpath) inside `root`.
    .get("/fs", (c) => {
      const root = c.req.query("root") ?? "";
      const sub = c.req.query("path");
      try {
        ensureRegisteredRoot(root, registeredRoots(deps.configStore.get().workspaces ?? [], deps.configStore.get().workspaceFolders));
        return c.json({ listing: listDir(root, sub) });
      } catch (err) {
        if (err instanceof FsError) return c.json({ error: err.message }, 400);
        throw err;
      }
    })
    // Serve ONE file's raw bytes for the workspace file viewer (text source
    // in the editor, image/pdf/video previews). Registered-root scoped,
    // realpath-contained, size-capped (1 MB text / 64 MB media). The mime
    // is sanitized (never text/html or text/javascript — a blob iframe on
    // the app origin must not receive executable content) and nosniff is
    // forced. Deliberately a raw Response, not c.json — media needs bytes.
    .get("/fs/file", (c) => {
      const root = c.req.query("root") ?? "";
      const sub = c.req.query("path");
      try {
        ensureRegisteredRoot(root, registeredRoots(deps.configStore.get().workspaces ?? [], deps.configStore.get().workspaceFolders));
        const file = readFile(root, sub);
        return new Response(Bun.file(file.path), {
          headers: {
            "Content-Type": file.mime,
            "Content-Length": String(file.size),
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (err) {
        if (err instanceof FsError) return c.json({ error: err.message }, 400);
        throw err;
      }
    })
    // Validate a single candidate path for the add-workspace form (exists,
    // is a directory, readable) — no listing, no content disclosure.
    .get("/fs/stat", (c) => {
      try {
        return c.json({ stat: statPath(c.req.query("path") ?? "", deps.home ?? homedir()) });
      } catch (err) {
        if (err instanceof FsError) return c.json({ error: err.message }, 400);
        throw err;
      }
    })
    // Create a missing folder (with parents) as a workspace target. The
    // server only allows creation inside the user's home directory —
    // see createFolder for the three safety guards.
    .post("/fs/mkdir", zValidator("json", z.object({ path: z.string().min(1).max(1024) })), (c) => {
      const body = c.req.valid("json");
      try {
        return c.json({ stat: createFolder(body.path, deps.home ?? homedir()) });
      } catch (err) {
        if (err instanceof FsError) return c.json({ error: err.message }, 400);
        throw err;
      }
    })
    // Upload ONE file into a workspace folder (web file-tree drag-and-drop),
    // raw body + `x-file-name`. Registered-root scoped, realpath-contained,
    // 64 MB cap, auto-renamed on collision. The written file is an ordinary
    // workspace file — visible in the tree and the `#file` mention picker.
    .post("/fs/upload", async (c) => {
      const root = c.req.query("root") ?? "";
      const dir = c.req.query("path");
      const rawName = c.req.header("x-file-name") ?? "";
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
      try {
        ensureRegisteredRoot(root, registeredRoots(deps.configStore.get().workspaces ?? [], deps.configStore.get().workspaceFolders));
        const declared = Number(c.req.header("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > FS_UPLOAD_MAX_BYTES) return c.json({ error: "file too large" }, 400);
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        const uploaded = writeFile(root, dir, name, bytes);
        return c.json({ uploaded }, 201);
      } catch (err) {
        if (err instanceof FsError) return c.json({ error: err.message }, 400);
        throw err;
      }
    })
    // One-segment directory-name completion for the path input (debounced
    // client-side). Directories only, capped; ~ expands to home; dotfiles
    // included only when requested (explorer's show-dotfiles toggle).
    .get("/fs/complete", (c) => {
      try {
        const includeHidden = ["1", "true"].includes(c.req.query("dotfiles") ?? "");
        return c.json({
          completion: completePath(c.req.query("path") ?? "", deps.home ?? homedir(), includeHidden),
        });
      } catch (err) {
        if (err instanceof FsError) return c.json({ error: err.message }, 400);
        throw err;
      }
    })
    // Recursive fuzzy file/folder search inside a REGISTERED workspace —
    // the composer's `#file` mention picker (opencode2's rg/fzf walk, one
    // server-side call). Hidden entries and ignored dirs are skipped; paths
    // are workspace-relative. Registered-root scoped like every fs route.
    .get("/fs/find", (c) => {
      const root = c.req.query("root") ?? "";
      const query = c.req.query("q") ?? "";
      const limit = Number(c.req.query("limit") ?? "20");
      try {
        ensureRegisteredRoot(root, registeredRoots(deps.configStore.get().workspaces ?? [], deps.configStore.get().workspaceFolders));
        return c.json({ found: findFiles(root, query, { limit }) });
      } catch (err) {
        if (err instanceof FsError) return c.json({ error: err.message }, 400);
        if (err instanceof Error) return c.json({ error: err.message }, 400);
        throw err;
      }
    })

    // --- providers & accounts ---
    // Merged view: catalog ⊕ config ⊕ accounts (keys never leave the server).
    // `?models=0` drops each provider's (potentially thousands-strong) model
    // array and reports `modelCount` — the connection/account pane's slim
    // fetch. Model pickers page `GET /model` instead.
    .get("/provider", async (c) => {
      const full = await deps.core.providers();
      const slim = c.req.query("models") === "0" || c.req.query("models") === "false";
      if (!slim) return c.json(full);
      return c.json({
        default: full.default,
        providers: full.providers.map((p) => ({ ...p, models: [], modelCount: p.models.length })),
      });
    })

    // --- models (flat, paged catalog for UI pickers) ---
    // Server-side slice of the merged catalog. `q` = substring over label/id/
    // provider; `provider` scopes to one provider (any connection state);
    // `id` is an exact lookup (capability/label badges); `zdr=1` floats
    // ZDR-capable models first — mirroring the surface pickers' ordering.
    .get("/model", async (c) => {
      const rawLimit = Number(c.req.query("limit") ?? "100");
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 100;
      const offset = Math.max(0, Number(c.req.query("offset") ?? "0") || 0);
      const q = c.req.query("q");
      const provider = c.req.query("provider");
      const id = c.req.query("id");
      const zdr = c.req.query("zdr") === "1" || c.req.query("zdr") === "true";
      const page = await deps.core.listModelsPage({
        limit,
        offset,
        ...(q !== undefined && q.length > 0 ? { q } : {}),
        ...(provider !== undefined && provider.length > 0 ? { provider } : {}),
        ...(id !== undefined && id.length > 0 ? { id } : {}),
        ...(zdr ? { zdr: true } : {}),
      });
      return c.json(page);
    })
    .put(
      "/provider/:provider/account/:account",
      zValidator("json", putAccountSchema),
      (c) => {
        const provider = c.req.param("provider");
        const account = c.req.param("account");
        const body = c.req.valid("json");
        try {
          const saved = deps.core.setAccount(provider, account, body);
          return c.json({ account: saved }, 201);
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      },
    )
    .delete("/provider/:provider/account/:account", (c) => {
      const provider = c.req.param("provider");
      const account = c.req.param("account");
      if (!deps.core.removeAccount(provider, account)) return c.json({ error: "not_found" }, 404);
      return c.json({ ok: true });
    })

    // --- OAuth logins (server-side sessions; device-code & paste-code) ---
    .get("/provider/oauth", (c) => c.json({ providers: deps.core.oauthProviders() }))
    .post("/provider/:provider/oauth/start", zValidator("json", oauthStartSchema), async (c) => {
      const provider = c.req.param("provider");
      const body = c.req.valid("json");
      try {
        const session = await deps.core.startOAuthLogin(provider, {
          ...(body.account !== undefined ? { account: body.account } : {}),
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
        });
        return c.json({ session }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .get("/provider/:provider/oauth/sessions/:session", (c) => {
      const session = deps.core.pollOAuthLogin(c.req.param("session"));
      if (session === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ session });
    })
    .post(
      "/provider/:provider/oauth/sessions/:session/submit",
      zValidator("json", oauthSubmitSchema),
      (c) => {
        try {
          const session = deps.core.submitOAuthLogin(c.req.param("session"), c.req.valid("json").code);
          return c.json({ session });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      },
    )
    .delete("/provider/:provider/oauth/sessions/:session", (c) => {
      const ok = deps.core.cancelOAuthLogin(c.req.param("session"));
      return c.json({ ok });
    })

    // --- custom providers (config-defined entities) ---
    .put("/provider/:provider/custom", zValidator("json", customProviderSchema), (c) => {
      const provider = c.req.param("provider");
      try {
        deps.core.setCustomProvider(provider, c.req.valid("json"));
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .delete("/provider/:provider/custom", (c) => {
      if (!deps.core.removeCustomProvider(c.req.param("provider"))) return c.json({ error: "not_found" }, 404);
      return c.json({ ok: true });
    })

    // --- session model/account (per-session override; ctrl+p writes here) ---
    .put("/session/:id/model", zValidator("json", setSessionModelSchema), (c) => {
      const id = c.req.param("id") as SessionId;
      const body = c.req.valid("json");
      const session = deps.core.setSessionModel(id, body);
      if (session === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ session });
    })

    // --- session agent selection (mirrors the model override) ---
    .put("/session/:id/agent", zValidator("json", setSessionAgentSchema), (c) => {
      const id = c.req.param("id") as SessionId;
      const body = c.req.valid("json");
      try {
        const session = deps.core.setSessionAgent(id, body);
        if (session === undefined) return c.json({ error: "not_found" }, 404);
        return c.json({ session });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })

    // --- session title (manual rename; auto-titles ride session.updated) ---
    .put("/session/:id/title", zValidator("json", renameSessionSchema), (c) => {
      const id = c.req.param("id") as SessionId;
      const body = c.req.valid("json");
      const session = deps.core.renameSession(id, body.title);
      if (session === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ session });
    })

    // --- session files (plans & notes; portable per-session markdown) ---
    // Plans/notes live on disk under <sessionFilesDir>/<sessionId>/ so they
    // travel with a session across surfaces. Mutations emit durable
    // session events (plans.updated / notes.updated) so open panels update.
    .get("/session/:id/notes", (c) => {
      const id = c.req.param("id") as SessionId;
      try {
        return c.json({ notes: deps.core.readNotes(id) });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
      }
    })
    .put("/session/:id/notes", zValidator("json", putNotesSchema), (c) => {
      const id = c.req.param("id") as SessionId;
      try {
        deps.core.writeNotes(id, c.req.valid("json").content);
        return c.json({ notes: c.req.valid("json").content });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
      }
    })
    .get("/session/:id/plan", (c) => {
      const id = c.req.param("id") as SessionId;
      try {
        return c.json({ plans: deps.core.listPlans(id) });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
      }
    })
    .get("/session/:id/plan/:name", (c) => {
      const id = c.req.param("id") as SessionId;
      const name = c.req.param("name");
      try {
        const content = deps.core.readPlan(id, name);
        if (content === undefined) return c.json({ error: "not_found" }, 404);
        const meta = deps.core.listPlans(id).find((p) => p.name === name);
        return c.json({
          plan: {
            name,
            content,
            bytes: meta?.bytes ?? Buffer.byteLength(content),
            updatedAt: meta?.updatedAt ?? new Date().toISOString(),
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Unknown session")) return c.json({ error: "not_found" }, 404);
        return c.json({ error: message }, 400);
      }
    })
    .put("/session/:id/plan/:name", zValidator("json", putPlanSchema), (c) => {
      const id = c.req.param("id") as SessionId;
      const name = c.req.param("name");
      try {
        return c.json({ plan: deps.core.writePlan(id, name, c.req.valid("json").content) }, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Unknown session")) return c.json({ error: "not_found" }, 404);
        return c.json({ error: message }, 400);
      }
    })
    .delete("/session/:id/plan/:name", (c) => {
      const id = c.req.param("id") as SessionId;
      const name = c.req.param("name");
      try {
        if (!deps.core.deletePlan(id, name)) return c.json({ error: "not_found" }, 404);
        return c.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Unknown session")) return c.json({ error: "not_found" }, 404);
        return c.json({ error: message }, 400);
      }
    })
    // The session checklist is session.meta.todos; this is the web editor's
    // replace path (same persistence + event as the agent's `todo` tool).
    .put("/session/:id/todo", zValidator("json", putTodosSchema), (c) => {
      const id = c.req.param("id") as SessionId;
      try {
        return c.json({ todos: deps.core.setTodos(id, c.req.valid("json").todos) });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
      }
    })

    // --- revert / fork (opencode parity; two-phase revert, see core Service) ---
    .post("/session/:id/revert", zValidator("json", revertSessionSchema), async (c) => {
      const id = c.req.param("id") as SessionId;
      const body = c.req.valid("json");
      try {
        const session = await deps.core.revertSession(id, body.messageId as MessageId);
        return c.json({ session });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Unknown session") || message.startsWith("Unknown message")) {
          return c.json({ error: "not_found" }, 404);
        }
        if (message.startsWith("Session is busy")) return c.json({ error: message }, 409);
        return c.json({ error: message }, 400);
      }
    })
    .post("/session/:id/unrevert", async (c) => {
      const id = c.req.param("id") as SessionId;
      try {
        const session = await deps.core.unrevertSession(id);
        return c.json({ session });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Unknown session")) return c.json({ error: "not_found" }, 404);
        if (message.startsWith("Session is busy")) return c.json({ error: message }, 409);
        return c.json({ error: message }, 400);
      }
    })
    .post("/session/:id/fork", zValidator("json", forkSessionSchema), async (c) => {
      const id = c.req.param("id") as SessionId;
      const body = c.req.valid("json");
      try {
        const session = await deps.core.forkSession(id, body.messageId as MessageId | undefined);
        return c.json({ session }, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Unknown session")) return c.json({ error: "not_found" }, 404);
        if (message.startsWith("Session is busy")) return c.json({ error: message }, 409);
        return c.json({ error: message }, 400);
      }
    })

    // --- jobs & assets ---
    .post("/job", zValidator("json", enqueueJobSchema), (c) => {
      const body = c.req.valid("json");
      const job = deps.core.enqueueJob(
        body.kind,
        body.sessionId !== undefined ? (body.sessionId as SessionId) : undefined,
        body.input,
      );
      return c.json({ job }, 202);
    })
    .get("/job/:id", (c) => {
      const job = deps.store.jobs.get(c.req.param("id"));
      if (job === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ job });
    })
    .post("/job/:id/cancel", (c) => {
      const job = deps.core.cancelJob(c.req.param("id") as JobId);
      if (job === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ job });
    })
    .post("/job/:id/retry", (c) => {
      const job = deps.core.retryJob(c.req.param("id") as JobId);
      if (job === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ job }, 202);
    })

    // --- image generation (single-page workbench) ---
    .post("/image/generate", zValidator("json", mediaGenRequestSchema), (c) => {
      const job = deps.core.enqueueImageGeneration(c.req.valid("json"));
      return c.json({ job }, 202);
    })
    .get("/image/capabilities", async (c) => {
      const provider = c.req.query("provider");
      const model = c.req.query("model");
      return c.json(
        await deps.core.imageCapabilities(
          provider !== undefined && provider.length > 0 ? provider : undefined,
          model !== undefined && model.length > 0 ? model : undefined,
        ),
      );
    })
    .get("/image/gallery", (c) => {
      const rawLimit = Number(c.req.query("limit") ?? "60");
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 60;
      const tagsRaw = c.req.query("tags");
      const tags =
        tagsRaw !== undefined && tagsRaw.length > 0
          ? tagsRaw.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
          : undefined;
      const rawBefore = c.req.query("before");
      let cursor: MediaGalleryCursor | undefined;
      if (rawBefore !== undefined && rawBefore.length > 0) {
        const decoded = decodeCursor<MediaGalleryCursor>(rawBefore);
        if (
          decoded === undefined ||
          typeof decoded.createdAt !== "string" ||
          typeof decoded.id !== "string"
        ) {
          return c.json({ error: "invalid before cursor" }, 400);
        }
        cursor = decoded;
      }
      return c.json(deps.core.imageGallery(limit, cursor, tags));
    })
    .get("/image/tags", (c) => {
      const rawLimit = Number(c.req.query("limit") ?? "50");
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;
      const q = c.req.query("q");
      return c.json({ tags: deps.core.imageTags(q, limit) });
    })
    .get("/image/recent", (c) => c.json(deps.core.imageRecent()))
    .get("/image/usage", zValidator("query", mediaUsageQuerySchema), (c) => {
      return c.json(deps.store.mediaUsage.analytics(c.req.valid("query")));
    })

    // --- automations (scheduled jobs) ---
    .get("/automation", (c) => c.json({ automations: deps.automations.list() }))
    .get("/automation/:id", (c) => {
      const id = c.req.param("id");
      const automation = deps.automations.get(id);
      if (automation === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ automation, runs: deps.automations.runs(id) });
    })
    .post("/automation", zValidator("json", createAutomationSchema), (c) => {
      try {
        const automation = deps.automations.create(c.req.valid("json"));
        return c.json({ automation }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .put("/automation/:id", zValidator("json", updateAutomationSchema), (c) => {
      try {
        const automation = deps.automations.update(c.req.param("id"), c.req.valid("json"));
        if (automation === undefined) return c.json({ error: "not_found" }, 404);
        return c.json({ automation });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .delete("/automation/:id", (c) => {
      if (!deps.automations.remove(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
      return c.json({ ok: true });
    })
    .post("/automation/:id/run", (c) => {
      try {
        const run = deps.automations.runNow(c.req.param("id"));
        if (run === undefined) return c.json({ error: "not_found" }, 404);
        return c.json({ run }, 202);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("already running")) return c.json({ error: message }, 409);
        return c.json({ error: message }, 400);
      }
    })
    .get("/asset", (c) => {
      const limit = Number(c.req.query("limit") ?? "100");
      const offset = Number(c.req.query("offset") ?? "0");
      return c.json({ assets: deps.store.assets.list(limit, offset) });
    })
    .get("/asset/:id/content", (c) => {
      const asset = deps.store.assets.get(c.req.param("id"));
      if (asset === undefined) return c.json({ error: "not_found" }, 404);
      return new Response(Bun.file(asset.path), {
        headers: {
          "Content-Type": asset.mime,
          "Content-Length": String(asset.bytes),
          "X-Content-Type-Options": "nosniff",
        },
      });
    })
    .delete("/asset/:id", (c) => {
      if (!deps.core.deleteAsset(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
      return c.json({ ok: true });
    })
    .put("/asset/:id/tags", zValidator("json", putAssetTagsSchema), (c) => {
      const asset = deps.core.setAssetTags(c.req.param("id"), c.req.valid("json").tags);
      if (asset === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ asset });
    })

    // --- attachments ---
    // Raw-byte upload for the web composer's `+` button (no multipart
    // precedent in this codebase; the body is the file, metadata rides
    // headers). Core classifies the type and stores bytes under <assetsDir>;
    // the returned AttachmentRef rides the next POST /session/:id/message.
    .post("/attachment", async (c) => {
      const rawName = c.req.header("x-file-name") ?? "attachment";
      const mime = c.req.header("content-type") ?? "";
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await c.req.arrayBuffer());
      } catch {
        return c.json({ error: "failed to read upload body" }, 400);
      }
      try {
        const attachment = deps.core.saveAttachment(bytes, name, mime);
        return c.json({ attachment }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })

    // --- usage analytics (D26) ---
    // Read-only aggregation over the append-only usage store; dollars are
    // computed at fetch time from each row's frozen rate snapshot.
    .get("/usage/analytics", zValidator("query", usageAnalyticsQuerySchema), (c) => {
      const query = c.req.valid("query");
      return c.json(deps.store.usage.analytics(query));
    });
}

/** Fully-typed /api router — the source of truth for the client's RPC types. */
export type ApiType = ReturnType<typeof buildApi>;

/**
 * The full HTTP boundary: /api router + workbench routes + static SPA hosting.
 * (The returned app's own generic schema is intentionally not exported — the
 * client types against ApiType mounted at baseURL + "/api".)
 */
export function createApp(deps: ApiDeps) {
  let app = new Hono();
  if (deps.token !== undefined && !deps.loopbackBind) {
    app = app.use("/api/*", bearerAuth(deps.token));
  }
  app = app.route("/api", buildApi(deps));

  // Workbench extra routes under /wb/<name>/ + static hosting last.
  // Methods are narrowed to literals: passing a union into app.on() degrades
  // Hono's route-type inference (harmless here, but kept clean anyway).
  let tail = new Hono();
  for (const wb of deps.core.workbenches) {
    for (const route of wb.routes()) {
      const wbPath = `/wb/${wb.name()}${route.path}`;
      const handler = (c: { req: { raw: Request } }) => route.handle(c.req.raw);
      if (route.method === "GET") tail = tail.get(wbPath, handler);
      else if (route.method === "POST") tail = tail.post(wbPath, handler);
      else if (route.method === "PUT") tail = tail.put(wbPath, handler);
      else if (route.method === "DELETE") tail = tail.delete(wbPath, handler);
    }
  }
  tail = tail.get("*", staticHandler(deps.webDist) as (c: Context) => Promise<Response>);
  app = app.route("/", tail);

  return app;
}
