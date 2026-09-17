import { timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpServerDeps } from "./deps";
import { mcpServerGate } from "./gate";
import { McpServerService } from "./server";

/** Loopback hostnames allowed as browser Origins when bound beyond loopback. */
const LOOPBACK_ORIGINS = ["localhost", "127.0.0.1", "[::1]"];

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Bearer-token gate with a `?token=` fallback for clients that cannot set
 * headers (the shell-WS precedent). Mirrors `@bai/api`: only applied when the
 * listener is bound beyond loopback.
 */
export function mcpAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : (c.req.query("token") ?? "");
    if (presented.length === 0 || !safeEqual(presented, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

/**
 * The `/mcp` routes (streamable HTTP, stateless v2). Composed into the main bai
 * server via `ApiDeps.extraRoutes`, never as a second process. Auth + the live
 * enable gate wrap the SDK handler.
 */
export function createMcpServerApp(deps: McpServerDeps): Hono {
  const service = new McpServerService(deps);
  // Loopback binds get the SDK's automatic DNS-rebinding (Host + Origin)
  // protection. `--host` disables the localhost-class default and pins Origin
  // to loopback, so a browser page cannot drive the endpoint cross-origin
  // (non-browser MCP clients send no Origin and pass).
  const app = deps.loopbackBind
    ? createMcpHonoApp()
    : createMcpHonoApp({ host: "0.0.0.0", allowedOrigins: LOOPBACK_ORIGINS });
  app.use("/mcp", mcpServerGate(deps));
  if (deps.token !== undefined && !deps.loopbackBind) {
    app.use("/mcp", mcpAuth(deps.token));
  }
  const handler = createMcpHandler(service.factory());
  app.all("/mcp", (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody" as never) }));
  return app;
}
