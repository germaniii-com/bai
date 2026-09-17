import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import {
  buildMcpToolAliases,
  filterMcpServerTools,
  type SessionId,
  type ToolListEntry,
} from "@bai/shared";
import { recordInbound, resultBytes } from "./analytics";
import type { McpServerDeps } from "./deps";

/**
 * The tool half of the MCP server role: bai's whole registry projected as MCP
 * tools under sanitized aliases (`fs.read` → `fs_read`, `mcp/<s>/<t>` →
 * `mcp__<s>__<t>`). Execution goes through `Service.executeToolCall` — the
 * same ToolContext + permission gate as the run loop, with the shared MCP
 * session's auto-approve.
 */

/** Registry tools that are safe to call without side effects (annotations only). */
const READ_ONLY_TOOLS = new Set([
  "fs.read",
  "fs.list",
  "fs.glob",
  "fs.grep",
  "web.search",
  "web.fetch",
  "skills.view",
  "agent.view",
  "notes.read",
  "plan.read",
  "mcp/list_resources",
  "mcp/read_resource",
  "mcp/list_prompts",
  "mcp/get_prompt",
]);

/**
 * Converted `fromJsonSchema` values, memoized per registry schema OBJECT. The
 * stateless handler builds a fresh McpServer per request, so without this the
 * ~40 registry schemas would be converted on every call. A failed conversion
 * is remembered as `null` and the tool is skipped (with a notice).
 */
const schemaCache = new WeakMap<object, ReturnType<typeof fromJsonSchema> | null>();

/** Convert one registry tool's JSON Schema, or undefined when invalid. */
export function schemaForTool(tool: ToolListEntry): ReturnType<typeof fromJsonSchema> | undefined {
  const key = tool.schema as object | null;
  if (key === null || typeof key !== "object") return undefined;
  const cached = schemaCache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const converted = fromJsonSchema(key as Parameters<typeof fromJsonSchema>[0]);
    schemaCache.set(key, converted);
    return converted;
  } catch {
    schemaCache.set(key, null);
    return undefined;
  }
}

/** The registry tools exposed under the current config filter. */
export function selectedTools(deps: McpServerDeps): ToolListEntry[] {
  const config = deps.config();
  const entries = deps.core.listTools();
  const allowed = new Set(filterMcpServerTools(entries.map((entry) => entry.name), config.mcpServer?.tools));
  return entries.filter((entry) => allowed.has(entry.name));
}

/** Register every exposed registry tool on the MCP server. */
export function registerToolCatalog(
  server: McpServer,
  deps: McpServerDeps,
  sharedSession: () => Promise<SessionId>,
): void {
  const entries = selectedTools(deps);
  const aliases = buildMcpToolAliases(entries.map((entry) => entry.name));
  for (const entry of entries) {
    const alias = aliases.byTool.get(entry.name);
    if (alias === undefined) continue;
    const inputSchema = schemaForTool(entry);
    if (inputSchema === undefined) {
      deps.onNotice?.(`mcp: skipping tool "${entry.name}" — its JSON Schema could not be converted`);
      continue;
    }
    const readOnly = READ_ONLY_TOOLS.has(entry.name);
    server.registerTool(
      alias,
      {
        title: entry.name,
        description: entry.description,
        inputSchema,
        annotations: { readOnlyHint: readOnly },
        _meta: { "bai/tool": entry.name, "bai/origin": entry.origin },
      },
      async (args) => {
        const sessionId = await sharedSession();
        const started = Date.now();
        try {
          const result = await deps.core.executeToolCall(entry.name, args, { sessionId });
          recordInbound(deps, {
            tool: entry.name,
            kind: "tool",
            ok: true,
            durationMs: Date.now() - started,
            bytes: resultBytes(result.content),
            sessionId,
            args,
          });
          return { content: [{ type: "text", text: result.content }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordInbound(deps, {
            tool: entry.name,
            kind: "tool",
            ok: false,
            durationMs: Date.now() - started,
            error: message,
            sessionId,
            args,
          });
          return { content: [{ type: "text", text: message }], isError: true };
        }
      },
    );
  }
}
