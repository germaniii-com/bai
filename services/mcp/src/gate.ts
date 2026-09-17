import type { Context, MiddlewareHandler } from "hono";
import type { McpServerDeps } from "./deps";

/**
 * Live enablement gate (the router gate's twin). `mcpServer.enabled` is read
 * per request, so toggling "Run as MCP server" in Settings takes effect without
 * a restart. A disabled server behaves as if its routes were not installed
 * (404), while the rest of bai keeps working.
 */
export function mcpServerGate(deps: McpServerDeps): MiddlewareHandler {
  return async (c, next) => {
    if (deps.enabled !== undefined && !deps.enabled()) {
      return mcpServerDisabled(c);
    }
    await next();
  };
}

/** 404 body for a disabled MCP server role. */
export function mcpServerDisabled(c: Context): Response {
  return c.json(
    {
      error: {
        message: "MCP server disabled (Settings → Integrations → Run as MCP server)",
        type: "mcp_disabled",
        code: null,
      },
    },
    404,
  );
}
