/**
 * MCP usage analytics — the shared contract for the `mcp_events` store's
 * aggregation API. One append-only row per MCP interaction (a namespaced
 * `mcp/<server>/<tool>` call or one of the `mcp/list_resources`,
 * `read_resource`, `list_prompts`, `get_prompt` helpers), with the invoking
 * session/agent and the outcome. Failed calls record ok = false plus the
 * error message (the D26 failed-call precedent). Raw arguments are never
 * stored — only a SHA-256 digest (first 16 hex chars) for frequency analysis.
 */
import type { UsageGranularity } from "./usage";

/** Which MCP surface produced a usage row. */
export type McpInteractionKind = "tool" | "resource" | "prompt";

/**
 * GET /api/mcp/usage query params — the same window/bucket semantics as the
 * usage and skill-usage analytics. `from` is inclusive, `to` EXCLUSIVE
 * (RFC3339 timestamps compare lexicographically). Dimension filters are
 * exact-match; omitted = unfiltered.
 */
export interface McpUsageQuery {
  from?: string;
  to?: string;
  granularity?: UsageGranularity;
  server?: string;
  agent?: string;
  kind?: McpInteractionKind;
}

/** Per-server totals (the MCP server detail pane / settings row). */
export interface McpUsageTotals {
  calls: number;
  /** Failed calls (server error, disconnect, protocol failure). */
  errors: number;
  /** Distinct sessions that called the server. */
  sessions: number;
  /** RFC3339 timestamp of the most recent call. */
  lastUsedAt?: string;
}

/** GET /api/mcp/usage response — aggregates over the append-only mcp_events store. */
export interface McpUsageResponse {
  kpis: {
    calls: number;
    errors: number;
    sessions: number;
    /** Distinct servers that were called (excludes the "(all)" helper scope). */
    servers: number;
    /** Total bytes returned by successful calls. */
    totalBytes: number;
    /** Mean call duration in milliseconds across all rows. */
    avgDurationMs: number;
  };
  /** Per-server totals, sorted by calls desc — the MCP activity table. */
  byServer: Array<{
    server: string;
    calls: number;
    errors: number;
    sessions: number;
    lastUsedAt?: string;
  }>;
  /** Per-server-per-tool totals, sorted by calls desc — the tool breakdown. */
  byTool: Array<{
    server: string;
    tool: string;
    kind: McpInteractionKind;
    calls: number;
    errors: number;
    avgDurationMs: number;
    bytes: number;
  }>;
  /** Per-bucket call/error counts — the activity series. */
  series: Array<{ bucket: string; calls: number; errors: number }>;
}
