import type {
  MediaEventId,
  MediaMode,
  MediaUsageQuery,
  MediaUsageResponse,
} from "@bai/shared";
import type { SQLQueryBindings } from "bun:sqlite";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

/**
 * One recorded image generation (image usage analytics): a terminal job, with
 * its provider/model/account/workflow, how many images it produced, the
 * provider-reported USD cost, duration, and outcome. Failed jobs record
 * ok = false plus the error message — the D26 failed-call precedent.
 */
export interface MediaEventRecord {
  id: MediaEventId;
  provider: string;
  account?: string;
  model: string;
  mode: MediaMode;
  /** Images produced (0 for failures). */
  images: number;
  /** Reported USD cost (0 when the provider didn't report one). */
  costUsd: number;
  durationMs: number;
  ok: boolean;
  /** Error message for FAILED jobs; undefined on success. */
  error?: string;
  createdAt: string;
}

interface MediaEventRow {
  id: string;
  provider: string;
  account: string | null;
  model: string;
  mode: string;
  images: number;
  cost_usd: number;
  duration_ms: number;
  ok: number;
  error: string | null;
  created_at: string;
}

function toRecord(row: MediaEventRow): MediaEventRecord {
  return {
    id: row.id as MediaEventId,
    provider: row.provider,
    ...(row.account !== null ? { account: row.account } : {}),
    model: row.model,
    mode: row.mode as MediaMode,
    images: row.images,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    ok: row.ok === 1,
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
  };
}

/**
 * The image-generation usage analytics store — one append-only row per
 * terminal image job. Plain aggregate data like the usage/skill_events/
 * mcp_events repos: not event-sourced, no bus integration; surfaces read it
 * through the GET /api/image/usage aggregation.
 */
export class MediaUsageRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: {
    provider: string;
    account?: string;
    model: string;
    mode: MediaMode;
    images?: number;
    costUsd?: number;
    durationMs?: number;
    ok?: boolean;
    error?: string;
    now: string;
  }): MediaEventRecord {
    const id = newId.mediaEvent();
    this.db
      .query(
        `INSERT INTO media_events (
           id, provider, account, model, mode, images, cost_usd, duration_ms, ok, error, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.provider,
        opts.account ?? null,
        opts.model,
        opts.mode,
        opts.images ?? 0,
        opts.costUsd ?? 0,
        opts.durationMs ?? 0,
        opts.ok === false ? 0 : 1,
        opts.error ?? null,
        opts.now,
      );
    return this.get(id) as MediaEventRecord;
  }

  get(id: string): MediaEventRecord | undefined {
    const row = q<MediaEventRow>(this.db, "SELECT * FROM media_events WHERE id = ?").get(id);
    return row ? toRecord(row) : undefined;
  }

  /** Most recent rows (debugging/tests; the API aggregates, never pages). */
  list(limit = 100): MediaEventRecord[] {
    return q<MediaEventRow>(
      this.db,
      "SELECT * FROM media_events ORDER BY created_at DESC, id DESC LIMIT ?",
    )
      .all(limit)
      .map(toRecord);
  }

  /**
   * The image usage aggregation (GET /api/image/usage): KPIs, per-model and
   * per-workflow totals, and the per-bucket series. Time buckets ride the UTC
   * RFC3339 prefix (day=10, month=7, year=4 chars) — the usage repo's
   * bucketing, verbatim.
   */
  analytics(query: MediaUsageQuery): MediaUsageResponse {
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
      ["provider", query.provider],
      ["account", query.account],
      ["model", query.model],
      ["mode", query.mode],
    ] as const) {
      if (value !== undefined && value.length > 0) {
        where.push(`${column} = ?`);
        whereParams.push(value);
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    // --- KPIs ---
    const kpiRow = q<{
      requests: number;
      images: number;
      spend: number;
      errors: number;
      avg_duration: number;
    }>(
      this.db,
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(images), 0) AS images,
              COALESCE(SUM(cost_usd), 0) AS spend,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(AVG(duration_ms), 0) AS avg_duration
       FROM media_events ${whereSql}`,
    ).get(...whereParams);
    const requests = kpiRow?.requests ?? 0;
    const images = kpiRow?.images ?? 0;
    const spendUsd = kpiRow?.spend ?? 0;

    // --- per-model totals (the image usage table) ---
    const byModel = q<{
      provider: string;
      model: string;
      requests: number;
      images: number;
      spend: number;
      errors: number;
      avg_duration: number;
    }>(
      this.db,
      `SELECT provider, model, COUNT(*) AS requests,
              COALESCE(SUM(images), 0) AS images,
              COALESCE(SUM(cost_usd), 0) AS spend,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(AVG(duration_ms), 0) AS avg_duration
       FROM media_events ${whereSql}
       GROUP BY provider, model
       ORDER BY images DESC, spend DESC, model`,
    ).all(...whereParams);

    // --- per-workflow totals (T2I / I2I) ---
    const byWorkflow = q<{
      mode: string;
      requests: number;
      images: number;
      spend: number;
    }>(
      this.db,
      `SELECT mode, COUNT(*) AS requests,
              COALESCE(SUM(images), 0) AS images,
              COALESCE(SUM(cost_usd), 0) AS spend
       FROM media_events ${whereSql}
       GROUP BY mode
       ORDER BY images DESC, mode`,
    ).all(...whereParams);

    // --- per-bucket series ---
    const series = q<{
      bucket: string;
      requests: number;
      images: number;
      spend: number;
      errors: number;
    }>(
      this.db,
      `SELECT substr(created_at, 1, ?) AS bucket, COUNT(*) AS requests,
              COALESCE(SUM(images), 0) AS images,
              COALESCE(SUM(cost_usd), 0) AS spend,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors
       FROM media_events ${whereSql}
       GROUP BY bucket
       ORDER BY bucket`,
    ).all(granLen, ...whereParams);

    return {
      kpis: {
        requests,
        images,
        spendUsd,
        errors: kpiRow?.errors ?? 0,
        avgCostPerImage: images > 0 ? spendUsd / images : 0,
        avgDurationMs: kpiRow?.avg_duration ?? 0,
      },
      byModel: byModel.map((r) => ({
        provider: r.provider,
        model: r.model,
        requests: r.requests,
        images: r.images,
        spendUsd: r.spend,
        errors: r.errors,
        avgDurationMs: r.avg_duration,
      })),
      byWorkflow: byWorkflow.map((r) => ({
        mode: r.mode as MediaMode,
        requests: r.requests,
        images: r.images,
        spendUsd: r.spend,
      })),
      series: series.map((r) => ({
        bucket: r.bucket,
        requests: r.requests,
        images: r.images,
        spendUsd: r.spend,
        errors: r.errors,
      })),
    };
  }
}
