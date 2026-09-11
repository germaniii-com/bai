/**
 * Token usage analytics (D26): the shared contract for the usage store's
 * aggregation API. Every LLM call records a kind-tagged row with token
 * counts and a per-row rate snapshot (effective USD per 1M tokens, frozen at
 * insert); dollars are computed at FETCH time as Σ(tokens × rate) / 1e6, so
 * history stays correct regardless of later catalog price edits.
 */

/** What kind of LLM call produced a usage row. Background calls (title
 *  generation, compaction summaries) are real spend, tagged for filtering. */
export type UsageKind = "run" | "title" | "compaction";

/**
 * The categories a turn's prompt is composed of (the web context-breakdown
 * modal's rows). `subagents` is the `task` tool's footprint; `mcp` is the
 * `mcp/<server>/…`-namespaced tools (none loaded yet).
 */
export type ContextCategory = "system" | "tools" | "skills" | "mcp" | "subagents" | "conversation";

/**
 * Estimated token composition of one turn's prompt, per category. Providers
 * report only the TOTAL context tokens, so these are chars/4 estimates and
 * are rendered with a `~` prefix. Recorded per provider turn alongside the
 * authoritative usage.
 */
export interface ContextBreakdown {
  /** Agent persona + env block. */
  system: number;
  /** Built-in/file tool JSON schemas (excludes `task` and `mcp/` tools). */
  tools: number;
  /** The `## Skills` index (with authoring guidance when applicable). */
  skills: number;
  /** `mcp/<server>` tool schemas. */
  mcp: number;
  /** The `task` tool's guidance + agent-type list. */
  subagents: number;
  /** Rendered conversation history (the non-system outbound messages). */
  conversation: number;
}

/**
 * The latest provider-reported usage of a session — the context tracker's
 * data shape everywhere (the `run.usage` event payload, `session.meta.
 * lastUsage`, and the history snapshot's `usage` field). All token fields
 * optional (providers vary); `contextWindow`/`model` ride along so surfaces
 * never need the provider catalog to render a percentage. After compaction
 * core emits a token-less row (only `contextWindow`) — "unknown until the
 * next turn", pi's `?` semantics.
 */
export interface SessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Subset of outputTokens (thinking) — never added on top. */
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  /** The model's context window at the time of the turn. */
  contextWindow?: number;
  /** Catalog id of the model that reported the usage. */
  model?: string;
  /** Estimated per-category prompt composition for that turn (web modal). */
  breakdown?: ContextBreakdown;
  /**
   * Cumulative ESTIMATED session spend in USD so far — the sum of every
   * recorded call's tokens × its frozen per-row rates (includes background
   * title/compaction calls, survives compaction). "Estimated" because it
   * prices catalog listings; exact provider billing may differ.
   */
  costUsd?: number;
}

/** Time-bucket size for the analytics series (UTC; RFC3339 substr). */
export type UsageGranularity = "day" | "month" | "year";

/** GET /api/usage/analytics query params. `from` is inclusive, `to`
 *  EXCLUSIVE (RFC3339 timestamps compare lexicographically). Dimension
 *  filters are exact-match; omitted = unfiltered. */
export interface UsageAnalyticsQuery {
  from?: string;
  to?: string;
  granularity?: UsageGranularity;
  agent?: string;
  workspace?: string;
  provider?: string;
  account?: string;
  model?: string;
  kind?: UsageKind;
}

/** Headline numbers for the filtered window. */
export interface UsageKpis {
  /** Σ(tokens × frozen rate) / 1e6 across every row in the window. */
  spendUsd: number;
  /** All token components: input + output + cache reads + cache writes. */
  totalTokens: number;
  requests: number;
  /** cacheRead ÷ (input + cacheRead + cacheWrite) — prompt-side hit rate, 0..1. */
  cacheHitRate: number;
  /** spendUsd ÷ totalTokens × 1e6 — the window's average price per 1M tokens. */
  blendedUsdPer1m: number;
}

/** Per-model totals for the filtered window (the usage-by-model table). */
export interface UsageModelTotals {
  model: string;
  provider: string;
  requests: number;
  /** Failed calls (provider errors) — rows with zero tokens. */
  errors: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  spendUsd: number;
}

export interface UsageAnalyticsResponse {
  kpis: UsageKpis;
  /** Sorted by spend desc — the usage-by-model table rows. */
  byModel: UsageModelTotals[];
  /** Per-bucket, per-model $ and tokens — the usage-by-model stacked bars'
   *  hover payload (one bar per bucket, one segment per model). */
  usageByModelSeries: { bucket: string; byModel: { model: string; spendUsd: number; tokens: number }[] }[];
  /** Per-bucket, per-model request counts — the shaded line chart. */
  requestVolume: { bucket: string; byModel: { model: string; requests: number }[] }[];
  /** Per-bucket prompt / reasoning / completion tokens (disjoint: completion
   *  = output − reasoning; prompt = input + cache reads + cache writes). */
  tokenBreakdown: { bucket: string; prompt: number; reasoning: number; completion: number }[];
  /** Per-bucket cached vs uncached prompt tokens — the prompt-caching bars. */
  cacheSeries: { bucket: string; cached: number; uncached: number }[];
  /** Per-bucket failed vs total calls — the error graph (failed calls are
   *  recorded as zero-token rows with the provider error message). */
  errorSeries: { bucket: string; requests: number; errors: number }[];
  /** Distinct dimension values (unfiltered) — the filter dropdowns' options. */
  facets: {
    agents: string[];
    workspaces: string[];
    providers: string[];
    accounts: string[];
    models: string[];
    kinds: UsageKind[];
  };
}
