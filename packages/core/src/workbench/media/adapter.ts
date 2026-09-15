import type { MediaCapabilities, MediaGenRequest, MediaModelInfo } from "@bai/shared";

/** Credentials resolved for a media provider (key + base URL + headers). */
export interface MediaAdapterCredentials {
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  headers?: Record<string, string>;
}

/** Runtime context handed to an adapter's generate call. */
export interface MediaGenContext {
  /** Aborts the upstream request (job timeout / cancellation). */
  signal: AbortSignal;
  /** Read a stored reference asset's bytes by asset id. */
  readAsset(id: string): { mime: string; bytes: Uint8Array } | undefined;
}

/** One image produced by an adapter (bytes only; the workbench adds metadata). */
export interface MediaGeneratedImage {
  mime: string;
  ext: string;
  bytes: Uint8Array;
}

/** An adapter's generation result: the images plus the provider's USD cost. */
export interface MediaGenerateResult {
  images: MediaGeneratedImage[];
  /** Total request cost in USD when the provider reports it. */
  costUsd?: number;
}

/**
 * A media-generation adapter. The workbench owns job/asset plumbing; the
 * adapter owns the provider wire protocol and declares its parameter
 * vocabulary so surfaces can render it generically.
 */
export interface MediaGenAdapter {
  readonly id: string;
  /** Fallback model when neither the request nor config names one. */
  defaultModel(): string;
  /** The parameter/capability vocabulary for a (possibly default) model. */
  capabilities(model?: string): MediaCapabilities;
  /** Curated selectable models (with rates) for the per-page picker. */
  listModels(): Promise<MediaModelInfo[]>;
  generate(input: {
    request: MediaGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<MediaGenerateResult>;
}

/**
 * A provider/generation failure. `retryable` lets the job queue retry
 * transient upstream errors (429/5xx/network) with backoff while failing
 * permanent ones (bad request, missing key) immediately.
 */
export class MediaGenError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, opts: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "MediaGenError";
    this.retryable = opts.retryable ?? false;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/** Whether a job error should be retried by the queue. */
export function isRetryableJobError(err: unknown): boolean {
  return err instanceof MediaGenError && err.retryable;
}
