import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { homedir } from "node:os";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  configPatchSchema,
  createSessionSchema,
  customThemeSchema,
  enqueueJobSchema,
  learnSkillSchema,
  permissionReplySchema,
  promptPayloadSchema,
  putAccountSchema,
  putAgentSchema,
  putSkillFileSchema,
  putSkillSchema,
  putToolSchema,
  questionRejectSchema,
  questionReplySchema,
  renameSessionSchema,
  revertSessionSchema,
  forkSessionSchema,
  setSessionAgentSchema,
  setSessionModelSchema,
  skillFilePathSchema,
  skillUsageQuerySchema,
  usageAnalyticsQuerySchema,
  type AttachmentRef,
  type InputId,
  type MessageId,
  type SessionId,
} from "@bai/shared";
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
    // Optional filters (web: chat section lists workbench=chat; the
    // workspace view lists cwd=<workspace path>).
    .get("/session", (c) => {
      const limit = Number(c.req.query("limit") ?? "50");
      const offset = Number(c.req.query("offset") ?? "0");
      const workbench = c.req.query("workbench");
      const cwd = c.req.query("cwd");
      return c.json({
        sessions: deps.core.listSessions(limit, offset, {
          ...(workbench !== undefined && workbench.length > 0 ? { workbench } : {}),
          ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
        }),
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
    .get("/session/:id/message", (c) => {
      const id = c.req.param("id") as SessionId;
      if (deps.core.getSession(id) === undefined) return c.json({ error: "not_found" }, 404);
      // Snapshot + cursor: clients resume the durable stream from afterSeq,
      // so replay never duplicates what this response already contains.
      return c.json(deps.core.sessionSnapshot(id));
    })
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
    .get("/skill", (c) => c.json({ skills: deps.core.listSkills() }))
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
        ensureRegisteredRoot(root, deps.configStore.get().workspaces ?? []);
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
        ensureRegisteredRoot(root, deps.configStore.get().workspaces ?? []);
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
        ensureRegisteredRoot(root, deps.configStore.get().workspaces ?? []);
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
        ensureRegisteredRoot(root, deps.configStore.get().workspaces ?? []);
        return c.json({ found: findFiles(root, query, { limit }) });
      } catch (err) {
        if (err instanceof FsError) return c.json({ error: err.message }, 400);
        if (err instanceof Error) return c.json({ error: err.message }, 400);
        throw err;
      }
    })

    // --- providers & accounts ---
    // Merged view: catalog ⊕ config ⊕ accounts (keys never leave the server).
    .get("/provider", async (c) => c.json(await deps.core.providers()))
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
