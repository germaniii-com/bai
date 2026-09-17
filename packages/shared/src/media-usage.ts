/**
 * Image-generation usage analytics — the shared contract for the
 * `media_events` store's aggregation API. One append-only row per terminal
 * image job (success or failure), mirroring the skill_events / mcp_events
 * ledgers. Unlike the token `usage` store, image cost is a flat USD per
 * request (the provider's reported cost), so spend is stored directly rather
 * than derived from tokens × rates.
 */
import type { MediaMode, VideoWorkflow } from "./media";
import type { UsageGranularity } from "./usage";

/** The modality a media event belongs to. */
export type MediaUsageKind = "image" | "video";

/**
 * GET /api/image/usage query params — the same window/bucket semantics as the
 * other analytics endpoints. `from` is inclusive, `to` EXCLUSIVE (RFC3339
 * timestamps compare lexicographically). Dimension filters are exact-match;
 * omitted = unfiltered.
 */
export interface MediaUsageQuery {
  from?: string;
  to?: string;
  granularity?: UsageGranularity;
  provider?: string;
  account?: string;
  model?: string;
  /** Modality filter; `/video/usage` forces "video". */
  kind?: MediaUsageKind;
  /** Image workflow (t2i/i2i) or video workflow (t2v/i2v/…). */
  mode?: MediaMode | VideoWorkflow;
}

/** GET /api/image/usage response — aggregates over the append-only media_events store. */
export interface MediaUsageResponse {
  kpis: {
    /** Terminal jobs (successful + failed). */
    requests: number;
    /** Images produced (successful jobs only). */
    images: number;
    /** Total reported USD spend across successful rows. */
    spendUsd: number;
    /** Failed jobs. */
    errors: number;
    /** spendUsd ÷ images — cost per produced image (0 when no images). */
    avgCostPerImage: number;
    /** Mean job duration in milliseconds across terminal rows. */
    avgDurationMs: number;
  };
  /** Per-model totals, sorted by images desc — the image usage table. */
  byModel: Array<{
    provider: string;
    model: string;
    requests: number;
    images: number;
    spendUsd: number;
    errors: number;
    avgDurationMs: number;
  }>;
  /** Per-workflow totals (image T2I/I2I; video t2v/i2v/…). */
  byWorkflow: Array<{
    mode: MediaMode | VideoWorkflow;
    requests: number;
    images: number;
    spendUsd: number;
  }>;
  /** Per-bucket request/image/spend/error counts — the activity series. */
  series: Array<{
    bucket: string;
    requests: number;
    images: number;
    spendUsd: number;
    errors: number;
  }>;
}
