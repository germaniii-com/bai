import { describe, expect, test } from "bun:test";
import { isRetryableApiError, MAX_API_RETRIES, RETRY_DELAYS_MS, retryAfterMs, sleepInterruptible } from "../src/provider/retry";

/** SDK APIError shape: an Error with `.status` and optional `.headers`. */
function apiError(status: number | undefined, headers?: Record<string, string>): Error {
  const err = new Error(status === undefined ? "connection error" : `HTTP ${status}`);
  if (status !== undefined) (err as { status?: number }).status = status;
  if (headers !== undefined) (err as { headers?: Record<string, string> }).headers = headers;
  return err;
}

describe("isRetryableApiError", () => {
  test("transient statuses are retryable", () => {
    for (const status of [408, 429, 500, 502, 503, 599]) {
      expect(isRetryableApiError(apiError(status))).toBe(true);
    }
  });

  test("non-transient statuses are not retryable", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableApiError(apiError(status))).toBe(false);
    }
  });

  test("no status (network/connection error) is retryable", () => {
    expect(isRetryableApiError(apiError(undefined))).toBe(true);
    expect(isRetryableApiError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableApiError("weird string")).toBe(true);
  });

  test("AbortError is never retryable (with or without status)", () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(isRetryableApiError(aborted)).toBe(false);
    const abortedApi = Object.assign(aborted, { status: 500 });
    expect(isRetryableApiError(abortedApi)).toBe(false);
  });
});

describe("retryAfterMs", () => {
  test("integer seconds form", () => {
    expect(retryAfterMs(apiError(429, { "retry-after": "2" }))).toBe(2000);
  });

  test("header name is case-insensitive", () => {
    expect(retryAfterMs(apiError(429, { "Retry-After": "5" }))).toBe(5000);
  });

  test("HTTP-date form: positive delta capped at 30s", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    expect(retryAfterMs(apiError(429, { "retry-after": future }))).toBe(30_000);
  });

  test("HTTP-date in the past → null (retry now)", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(retryAfterMs(apiError(429, { "retry-after": past }))).toBeNull();
  });

  test("missing/garbage headers → null", () => {
    expect(retryAfterMs(apiError(429))).toBeNull();
    expect(retryAfterMs(apiError(429, {}))).toBeNull();
    expect(retryAfterMs(apiError(429, { "retry-after": "soon" }))).toBeNull();
    expect(retryAfterMs(new Error("no headers"))).toBeNull();
  });

  test("cap: a huge Retry-After never exceeds 30s", () => {
    expect(retryAfterMs(apiError(429, { "retry-after": "3600" }))).toBe(30_000);
  });
});

describe("sleepInterruptible", () => {
  test("resolves true after the delay", async () => {
    const start = Date.now();
    const ok = await sleepInterruptible(30, new AbortController().signal);
    expect(ok).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  test("resolves false immediately on a pre-aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await sleepInterruptible(10_000, ctrl.signal)).toBe(false);
  });

  test("resolves false as soon as the signal aborts mid-wait", async () => {
    const ctrl = new AbortController();
    const promise = sleepInterruptible(10_000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    const start = Date.now();
    expect(await promise).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("constants", () => {
  test("3 total attempts with backoff steps for every retry", () => {
    expect(MAX_API_RETRIES).toBe(3);
    expect(RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(MAX_API_RETRIES - 1);
  });
});
