import type { SessionId, UsageAnalyticsQuery, UsageAnalyticsResponse } from "@bai/shared";
import type { SQLQueryBindings } from "bun:sqlite";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

/**
 * Effective per-component rates for one request — USD per 1M tokens,
 * snapshotted at insert time (catalog price × the vendor's cache billing
 * multipliers, applied by the registry). Dollars are computed at FETCH time
 * as Σ(tokens × rate) / 1e6, so history stays correct regardless of later
 * catalog price edits, and every $ figure is auditable down to the row.
 */
export interface UsageRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

export const ZERO_RATES: UsageRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };

/** What kind of LLM call produced this row — user-driven runs vs the two
 *  background call families (both real spend, filterable separately). */
export type UsageKind = "run" | "title" | "compaction";

/** One recorded LLM request (D26): token counts + the frozen rate snapshot.
 *  Failed calls record zero tokens plus the provider error message. */
export interface UsageRecord {
  id: string;
  sessionId?: SessionId;
  kind: UsageKind;
  /** Agent name for run rows; undefined for background (title/compaction). */
  agent?: string;
  /** Session cwd (the workspace dimension); undefined for chat sessions. */
  workspace?: string;
  provider: string;
  account?: string;
  /** Vendor-side model id (no provider prefix — `provider` is its own column). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Subset of outputTokens (thinking), when the provider reports it. */
  reasoningTokens?: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  rates: UsageRates;
  /** Provider error message for FAILED calls; undefined on success. */
  error?: string;
  createdAt: string;
}

interface UsageRow {
  id: string;
  session_id: string | null;
  kind: string;
  agent: string | null;
  workspace: string | null;
  provider: string;
  account: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number | null;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens: number;
  input_rate_usd_1m: number;
  output_rate_usd_1m: number;
  cache_read_rate_usd_1m: number;
  cache_write_rate_usd_1m: number;
  cache_write_1h_rate_usd_1m: number;
  error: string | null;
  created_at: string;
}

function toRecord(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    ...(row.session_id !== null ? { sessionId: row.session_id as SessionId } : {}),
    kind: row.kind as UsageKind,
    ...(row.agent !== null ? { agent: row.agent } : {}),
    ...(row.workspace !== null ? { workspace: row.workspace } : {}),
    provider: row.provider,
    ...(row.account !== null ? { account: row.account } : {}),
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    ...(row.reasoning_tokens !== null ? { reasoningTokens: row.reasoning_tokens } : {}),
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheWrite1hTokens: row.cache_write_1h_tokens,
    rates: {
      input: row.input_rate_usd_1m,
      output: row.output_rate_usd_1m,
      cacheRead: row.cache_read_rate_usd_1m,
      cacheWrite: row.cache_write_rate_usd_1m,
      cacheWrite1h: row.cache_write_1h_rate_usd_1m,
    },
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
  };
}

/**
 * The usage analytics store — one append-only row per provider LLM call
 * (run turns, title refines, compaction summaries). Plain aggregate data
 * like permissions/jobs: not event-sourced, no bus integration; surfaces
 * read it through the analytics API.
 */
export class UsageRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: {
    sessionId?: SessionId;
    kind: UsageKind;
    agent?: string;
    workspace?: string | null;
    provider: string;
    account?: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheWrite1hTokens?: number;
    rates?: UsageRates;
    /** Provider error message — failed calls record zero tokens + this. */
    error?: string;
    now: string;
  }): UsageRecord {
    const id = newId.usage();
    const rates = opts.rates ?? ZERO_RATES;
    this.db
      .query(
        `INSERT INTO usage (
          id, session_id, kind, agent, workspace, provider, account, model,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
          input_rate_usd_1m, output_rate_usd_1m, cache_read_rate_usd_1m,
          cache_write_rate_usd_1m, cache_write_1h_rate_usd_1m, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId ?? null,
        opts.kind,
        opts.agent ?? null,
        opts.workspace ?? null,
        opts.provider,
        opts.account ?? null,
        opts.model,
        opts.inputTokens ?? 0,
        opts.outputTokens ?? 0,
        opts.reasoningTokens ?? null,
        opts.cacheReadTokens ?? 0,
        opts.cacheWriteTokens ?? 0,
        opts.cacheWrite1hTokens ?? 0,
        rates.input,
        rates.output,
        rates.cacheRead,
        rates.cacheWrite,
        rates.cacheWrite1h,
        opts.error ?? null,
        opts.now,
      );
    return this.get(id) as UsageRecord;
  }

  get(id: string): UsageRecord | undefined {
    const row = q<UsageRow>(this.db, "SELECT * FROM usage WHERE id = ?").get(id);
    return row ? toRecord(row) : undefined;
  }

  /** Most recent rows (debugging/tests; the API aggregates, never pages). */
  list(limit = 100): UsageRecord[] {
    return q<UsageRow>(this.db, "SELECT * FROM usage ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map(toRecord);
  }

  /**
   * The analytics aggregation (GET /api/usage/analytics): KPIs, per-model
   * totals, and the four chart series, all computed in SQL over the frozen
   * per-row rates. Dollars are derived at fetch time — Σ(tokens × rate) /
   * 1e6 — so a row's spend is reproducible forever from its own columns.
   * Time buckets ride the UTC RFC3339 prefix (day=10, month=7, year=4
   * chars), which sorts lexicographically.
   */
  analytics(query: UsageAnalyticsQuery): UsageAnalyticsResponse {
    const granLen = query.granularity === "month" ? 7 : query.granularity === "year" ? 4 : 10;

    // --- WHERE (shared by every filtered query) ---
    const where: string[] = [];
    const whereParams: SQLQueryBindings[] = [];
    if (query.from !== undefined && query.from.length > 0) {
      where.push("created_at >= ?");
      whereParams.push(query.from);
    }
    if (query.to !== undefined && query.to.length > 0) {
      where.push("created_at < ?");
      whereParams.push(query.to);
    }
    for (const [column, value] of [
      ["agent", query.agent],
      ["workspace", query.workspace],
      ["provider", query.provider],
      ["account", query.account],
      ["model", query.model],
      ["kind", query.kind],
    ] as const) {
      if (value !== undefined && value.length > 0) {
        where.push(`${column} = ?`);
        whereParams.push(value);
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    // Fetch-time cost from the row's own frozen rates (USD).
    const COST = `(
      input_tokens * input_rate_usd_1m
      + output_tokens * output_rate_usd_1m
      + cache_read_tokens * cache_read_rate_usd_1m
      + cache_write_tokens * cache_write_rate_usd_1m
      + cache_write_1h_tokens * cache_write_1h_rate_usd_1m
    ) / 1000000.0`;
    // Components are disjoint (adapters normalize) — the true token total.
    const TOTAL_TOKENS = `(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)`;

    // --- KPIs ---
    const kpiRow = q<{
      requests: number;
      tokens: number;
      prompt_tokens: number;
      cache_read: number;
      spend: number;
    }>(
      this.db,
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(${TOTAL_TOKENS}), 0) AS tokens,
              COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
              COALESCE(SUM(${COST}), 0) AS spend
       FROM usage ${whereSql}`,
    ).get(...whereParams);
    const requests = kpiRow?.requests ?? 0;
    const totalTokens = kpiRow?.tokens ?? 0;
    const spendUsd = kpiRow?.spend ?? 0;
    const promptTokens = kpiRow?.prompt_tokens ?? 0;
    const cacheReadTokens = kpiRow?.cache_read ?? 0;

    // --- per-model totals (the usage-by-model table) ---
    interface ModelRow {
      provider: string;
      model: string;
      requests: number;
      errors: number;
      input: number;
      output: number;
      reasoning: number;
      cache_read: number;
      cache_write: number;
      spend: number;
    }
    const byModel = q<ModelRow>(
      this.db,
      `SELECT provider, model, COUNT(*) AS requests,
              COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoning,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
              COALESCE(SUM(${COST}), 0) AS spend
       FROM usage ${whereSql}
       GROUP BY provider, model
       ORDER BY spend DESC, model`,
    ).all(...whereParams);

    // --- per-bucket, per-model series (usage-by-model bars + request volume) ---
    interface BucketModelRow {
      bucket: string;
      model: string;
      requests: number;
      tokens: number;
      spend: number;
    }
    const bucketModelRows = q<BucketModelRow>(
      this.db,
      `SELECT substr(created_at, 1, ?) AS bucket, model, COUNT(*) AS requests,
              COALESCE(SUM(${TOTAL_TOKENS}), 0) AS tokens,
              COALESCE(SUM(${COST}), 0) AS spend
       FROM usage ${whereSql}
       GROUP BY bucket, model
       ORDER BY bucket`,
    ).all(granLen, ...whereParams);

    const usageByModelSeries: UsageAnalyticsResponse["usageByModelSeries"] = [];
    const requestVolume: UsageAnalyticsResponse["requestVolume"] = [];
    let currentBucket: string | undefined;
    let usageEntry: UsageAnalyticsResponse["usageByModelSeries"][number] | undefined;
    let volumeEntry: UsageAnalyticsResponse["requestVolume"][number] | undefined;
    for (const row of bucketModelRows) {
      if (row.bucket !== currentBucket) {
        currentBucket = row.bucket;
        usageEntry = { bucket: row.bucket, byModel: [] };
        volumeEntry = { bucket: row.bucket, byModel: [] };
        usageByModelSeries.push(usageEntry);
        requestVolume.push(volumeEntry);
      }
      usageEntry?.byModel.push({ model: row.model, spendUsd: row.spend, tokens: row.tokens });
      volumeEntry?.byModel.push({ model: row.model, requests: row.requests });
    }

    // --- token breakdown (prompt / reasoning / completion, disjoint) ---
    const tokenBreakdown = q<{ bucket: string; prompt: number; reasoning: number; completion: number }>(
      this.db,
      `SELECT substr(created_at, 1, ?) AS bucket,
              COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS prompt,
              COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoning,
              COALESCE(SUM(output_tokens - COALESCE(reasoning_tokens, 0)), 0) AS completion
       FROM usage ${whereSql}
       GROUP BY bucket
       ORDER BY bucket`,
    ).all(granLen, ...whereParams);

    // --- prompt caching (cached reads vs uncached prompt) ---
    const cacheSeries = q<{ bucket: string; cached: number; uncached: number }>(
      this.db,
      `SELECT substr(created_at, 1, ?) AS bucket,
              COALESCE(SUM(cache_read_tokens), 0) AS cached,
              COALESCE(SUM(input_tokens + cache_write_tokens), 0) AS uncached
       FROM usage ${whereSql}
       GROUP BY bucket
       ORDER BY bucket`,
    ).all(granLen, ...whereParams);

    // --- errors (failed calls vs total volume per bucket) ---
    const errorSeries = q<{ bucket: string; requests: number; errors: number }>(
      this.db,
      `SELECT substr(created_at, 1, ?) AS bucket,
              COUNT(*) AS requests,
              COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors
       FROM usage ${whereSql}
       GROUP BY bucket
       ORDER BY bucket`,
    ).all(granLen, ...whereParams);

    // --- facets (unfiltered distinct values — the filter dropdowns) ---
    const distinct = (column: string): string[] =>
      q<{ v: string }>(this.db, `SELECT DISTINCT ${column} AS v FROM usage WHERE ${column} IS NOT NULL ORDER BY v`)
        .all()
        .map((r) => r.v);

    return {
      kpis: {
        spendUsd,
        totalTokens,
        requests,
        cacheHitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : 0,
        blendedUsdPer1m: totalTokens > 0 ? (spendUsd / totalTokens) * 1_000_000 : 0,
      },
      byModel: byModel.map((r) => ({
        model: r.model,
        provider: r.provider,
        requests: r.requests,
        errors: r.errors,
        inputTokens: r.input,
        outputTokens: r.output,
        reasoningTokens: r.reasoning,
        cacheReadTokens: r.cache_read,
        cacheWriteTokens: r.cache_write,
        spendUsd: r.spend,
      })),
      usageByModelSeries,
      requestVolume,
      tokenBreakdown,
      cacheSeries,
      errorSeries,
      facets: {
        agents: distinct("agent"),
        workspaces: distinct("workspace"),
        providers: distinct("provider"),
        accounts: distinct("account"),
        models: distinct("model"),
        kinds: distinct("kind") as UsageAnalyticsResponse["facets"]["kinds"],
      },
    };
  }
}
