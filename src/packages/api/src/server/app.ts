import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import {
  configPatchSchema,
  createSessionSchema,
  enqueueJobSchema,
  permissionReplySchema,
  promptPayloadSchema,
  type SessionId,
} from "@bai/shared";
import { bearerAuth } from "./auth";
import type { ApiDeps } from "./deps";
import { runDurableStream, runFirehose } from "./sse";
import { staticHandler } from "./static";

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
    .get("/session", (c) => {
      const limit = Number(c.req.query("limit") ?? "50");
      const offset = Number(c.req.query("offset") ?? "0");
      return c.json({ sessions: deps.core.listSessions(limit, offset) });
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
    .post("/session/:id/message", zValidator("json", promptPayloadSchema), (c) => {
      const id = c.req.param("id") as SessionId;
      const body = c.req.valid("json");
      try {
        const input = deps.core.submitPrompt(id, body);
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

    // --- permissions ---
    .post("/permission/:id/reply", zValidator("json", permissionReplySchema), (c) => {
      const body = c.req.valid("json");
      const request = deps.core.replyPermission(c.req.param("id"), body.status);
      if (request === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ request });
    })

    // --- config ---
    .get("/config", (c) => c.json({ config: deps.configStore.get() }))
    .put("/config", zValidator("json", configPatchSchema), (c) => {
      const patch = c.req.valid("json");
      const config = deps.configStore.update(patch);
      deps.core.emitLive("config.updated", {});
      return c.json({ config });
    })

    // --- providers ---
    .get("/provider", async (c) => {
      const models = await deps.providers.allModels();
      return c.json({ providers: deps.providers.list().map((p) => p.name()), models });
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
      return new Response(Bun.file(asset.path), { headers: { "Content-Type": asset.mime } });
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
