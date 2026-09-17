import { z } from "zod";

/**
 * bai as an MCP **server** (the dual-role server endpoint at `/mcp`).
 *
 * Distinct from {@link import("./config").MCPServerConfig}, which describes an
 * EXTERNAL server bai consumes as a client. These are bai's own server-role
 * settings plus the wire-safety helpers that map bai's registry tool names
 * (`fs.read`, `mcp/<server>/<tool>`) onto MCP/LLM-safe aliases.
 */

/** Tool exposure filter for the server role (default: everything). */
export interface McpServerRoleToolsConfig {
  /** When set, expose only these registry tool names. */
  include?: string[];
  /** Registry tool names hidden from the MCP surface. */
  exclude?: string[];
}

/** Shape of the shared session external MCP calls run under. */
export interface McpServerRoleSessionConfig {
  /** Agent for the shared session (default: config `agents.default` → build). */
  agent?: string;
  /** Working directory (default: process cwd). */
  cwd?: string;
  /** Explicit `provider/model` pinned into the shared session. */
  model?: string;
  /** Saved account for the pinned model. */
  account?: string;
}

/**
 * The `config.mcpServer` block. `enabled` defaults to OFF (unset = disabled):
 * the endpoint executes bai's tools with the shared session's auto-approve, so
 * exposing it is an explicit opt-in (`--mcp` forces it on, router parity).
 */
export interface McpServerRoleConfig {
  enabled?: boolean;
  tools?: McpServerRoleToolsConfig;
  /** Auto-approve every tool call in the shared session (default true). */
  autoApprove?: boolean;
  session?: McpServerRoleSessionConfig;
}

/** Read-only status for the Settings card (`GET /api/mcp/server-role`). */
export interface McpServerRoleStatus {
  enabled: boolean;
  /** Registry tools exposed by the server role (after filtering). */
  tools: number;
  /** Skills exposed as MCP prompts/resources. */
  skills: number;
  /** Sessions visible to `session_list`. */
  sessions: number;
  transport: "streamable-http";
}

export const mcpServerRoleToolsSchema = z.object({
  include: z.array(z.string().min(1).max(200)).max(500).optional(),
  exclude: z.array(z.string().min(1).max(200)).max(500).optional(),
});

export const mcpServerRoleSessionSchema = z.object({
  agent: z.string().min(1).max(100).optional(),
  cwd: z.string().min(1).max(1024).optional(),
  model: z.string().min(1).max(200).optional(),
  account: z.string().min(1).max(100).optional(),
});

export const mcpServerRoleSchema = z.object({
  enabled: z.boolean().optional(),
  tools: mcpServerRoleToolsSchema.optional(),
  autoApprove: z.boolean().optional(),
  session: mcpServerRoleSessionSchema.optional(),
});

/**
 * Registry tools that can never run unattended: they block on a human
 * (`question` broadcasts a question to a surface and waits). The server role
 * always hides them unless a config `tools.include` names one explicitly.
 */
export const MCP_SERVER_ALWAYS_EXCLUDE: readonly string[] = ["question"];

/**
 * The `server` value recorded in `mcp_events` for INBOUND calls (external MCP
 * clients driving bai), so the Analytics "MCP activity" card distinguishes
 * bai-as-server usage from client-side `mcp/<server>/<tool>` usage.
 */
export const MCP_SERVER_ROLE_LABEL = "(bai)";

/** Maximum MCP tool-name length (Anthropic-compatible `^[a-zA-Z0-9_-]{1,64}$`). */
export const MCP_TOOL_ALIAS_MAX = 64;

/** One registry name sanitized to the MCP/LLM tool-name charset. */
function baseAlias(name: string): string {
  let alias = name.replace(/\//g, "__").replace(/\./g, "_");
  alias = alias.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (alias.length === 0 || !/^[a-zA-Z]/.test(alias)) alias = `t_${alias}`;
  return alias.slice(0, MCP_TOOL_ALIAS_MAX);
}

/** Bidirectional alias mapping for one tool set. */
export interface McpToolAliases {
  /** Original registry name → MCP alias. */
  readonly byTool: ReadonlyMap<string, string>;
  /** MCP alias → original registry name. */
  readonly byAlias: ReadonlyMap<string, string>;
}

/**
 * Build the alias map for a registry tool set. Deterministic: input order wins,
 * a colliding alias gets a `_2`, `_3`, … suffix (then re-truncated). Registry
 * names are unique, so the maps are bijective.
 */
export function buildMcpToolAliases(names: readonly string[]): McpToolAliases {
  const byTool = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    let alias = baseAlias(name);
    if (used.has(alias)) {
      let i = 2;
      let candidate = `${alias}_${i}`.slice(0, MCP_TOOL_ALIAS_MAX);
      while (used.has(candidate)) {
        i += 1;
        candidate = `${alias}_${i}`.slice(0, MCP_TOOL_ALIAS_MAX);
      }
      alias = candidate;
    }
    used.add(alias);
    byTool.set(name, alias);
    byAlias.set(alias, name);
  }
  return { byTool, byAlias };
}

/** Convenience: the alias for a single name with no collision context. */
export function mcpToolAlias(name: string): string {
  return baseAlias(name);
}

/**
 * Apply the server-role tool filter: `include` (when set) is a whitelist,
 * `exclude` removes, and {@link MCP_SERVER_ALWAYS_EXCLUDE} is removed unless it
 * was named in `include` (an explicit opt-in overrides the safety default).
 */
export function filterMcpServerTools(
  names: readonly string[],
  config: McpServerRoleToolsConfig | undefined,
): string[] {
  const include = config?.include;
  const exclude = new Set(config?.exclude ?? []);
  const explicit = new Set(include ?? []);
  return names.filter((name) => {
    if (include !== undefined && include.length > 0 && !explicit.has(name)) return false;
    if (exclude.has(name)) return false;
    if (MCP_SERVER_ALWAYS_EXCLUDE.includes(name) && !explicit.has(name)) return false;
    return true;
  });
}
