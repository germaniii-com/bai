/**
 * Auto-retry policy for transient provider API failures (pre-stream only).
 *
 * The run loop re-issues the provider stream call up to MAX_API_RETRIES times
 * when the call fails before any tokens streamed with a transient error
 * (429, 408, 5xx, network/connection errors). Non-transient errors
 * (401/403/400/404) and aborts fail immediately. Backoff honors the
 * provider's Retry-After header when present (capped), else fixed short
 * delays.
 */

/** Total attempts per provider call (not retries-after-first). */
export const MAX_API_RETRIES = 3;

/** Fixed backoff between attempt n and n+1 when no Retry-After is present. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** Upper bound on a Retry-After wait so a hostile header can't stall a run. */
const RETRY_AFTER_CAP_MS = 30_000;

/**
 * Transient = 408/429/5xx, or no status at all (network/connection errors
 * thrown by the SDKs carry no `.status`). AbortError is never retryable —
 * an interrupt is a clean stop, not a failure.
 */
export function isRetryableApiError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  const status = (err as { status?: number } | null)?.status;
  if (typeof status !== "number") return true; // connection-level failure
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Retry-After from an SDK APIError's response headers (integer seconds or an
 * HTTP-date), read case-insensitively. Returns null when absent or
 * unparseable; the value is capped at RETRY_AFTER_CAP_MS.
 */
export function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: unknown } | null)?.headers;
  if (headers === null || typeof headers !== "object") return null;
  const record = headers as Record<string, unknown>;
  const raw = Object.entries(record).find(([k]) => k.toLowerCase() === "retry-after")?.[1];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = String(raw).trim();
  if (value.length === 0) return null;

  // Integer seconds form.
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }

  // HTTP-date form.
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  const delta = date - Date.now();
  if (delta <= 0) return null;
  return Math.min(delta, RETRY_AFTER_CAP_MS);
}

/**
 * Sleep for `ms`, resolving false as soon as `signal` aborts (so an interrupt
 * during a retry wait stops the run instantly), true after the full delay.
 */
export function sleepInterruptible(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
