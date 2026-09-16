/**
 * Provider tool-name sanitization.
 *
 * OpenAI and Anthropic both constrain function/tool names to
 * `^[a-zA-Z0-9_-]{1,64}$`. bai's built-ins are namespaced with dots
 * ("fs.read", "skills.view") and MCP tools with slashes
 * ("mcp/<server>/<tool>"), which strict OpenAI-compatible gateways (e.g.
 * Console Go) reject with a 400 *before the model ever runs* — so no prompt,
 * mention included, reaches the provider. The adapters translate real
 * registry names to a provider-safe alias on the way out and translate the
 * model's echoed alias back to the real name on the way in, so every tool
 * still executes under its registry name (agent allow-lists, permission
 * gates, transcripts, and tool results all stay unchanged).
 */

/** Characters providers reject in a function/tool name. */
const INVALID = /[^a-zA-Z0-9_-]/g;

/** OpenAI/Anthropic name length cap. */
const MAX_LENGTH = 64;

/** Replace rejected characters with "_" and cap at 64; never returns "". */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(INVALID, "_").slice(0, MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : "tool";
}

/** Bidirectional per-request mapping between registry names and aliases. */
export interface ToolNameMap {
  /** Real registry name → provider-safe alias. */
  toProvider: Map<string, string>;
  /** Provider-safe alias → real registry name. */
  toReal: Map<string, string>;
}

/**
 * Build the per-request alias mapping. Aliases are unique per request: two
 * real names that sanitize to the same alias (e.g. "fs.read" and "fs_read")
 * get a numeric suffix on the later entry, deterministically in tool order.
 * Both adapters derive the map the same way from the same tool list, so the
 * outbound definitions and the inbound translation always agree.
 */
export function buildToolNameMap(tools: readonly { name: string }[]): ToolNameMap {
  const toProvider = new Map<string, string>();
  const toReal = new Map<string, string>();
  const used = new Set<string>();
  for (const tool of tools) {
    const base = sanitizeToolName(tool.name);
    let alias = base;
    let n = 2;
    while (used.has(alias)) {
      const suffix = `_${n++}`;
      alias = `${base.slice(0, MAX_LENGTH - suffix.length)}${suffix}`;
    }
    used.add(alias);
    toProvider.set(tool.name, alias);
    toReal.set(alias, tool.name);
  }
  return { toProvider, toReal };
}
