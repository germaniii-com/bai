/**
 * Shared transport helpers for media-generation adapters.
 *
 * Every adapter talks its provider's REST API directly (native `fetch`/
 * `FormData`), so this module centralizes the parts that are identical across
 * vendors: JSON/multipart POSTs, HTTP status → `MediaGenError` mapping (with
 * the queue's retryability rule), downloading a provider image URL into bytes,
 * base64/data-URL conversion, and an abort-aware async poller for the
 * submit→poll providers (BFL, fal.ai, Replicate).
 */

import { MediaGenError, type MediaGeneratedImage } from "./adapter";
import { imageDimensions } from "./dimensions";

/** Extract a human message from a provider error body (JSON or raw text). */
export function errorMessage(text: string): string | undefined {
  if (text.length === 0) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error === "object" && parsed.error !== null) {
      const nested = parsed.error as { message?: unknown; detail?: unknown };
      if (typeof nested.message === "string") return nested.message;
      if (typeof nested.detail === "string") return nested.detail;
    }
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // fall through to the raw text
  }
  return text.slice(0, 400);
}

/** Throwing guard for a non-2xx response; 429/5xx become retryable. */
export async function ensureOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  throw new MediaGenError(errorMessage(text) ?? `${label} failed (${res.status})`, {
    retryable: res.status === 429 || res.status >= 500,
    status: res.status,
  });
}

/** POST JSON, mapping transport + HTTP failures to `MediaGenError`. */
export async function postJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; label: string },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new MediaGenError(err instanceof Error ? err.message : String(err), { retryable: true });
  }
  await ensureOk(res, opts.label);
  return res.json().catch(() => undefined);
}

/** GET JSON (polling/status endpoints), mapping failures to `MediaGenError`. */
export async function getJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; label: string },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { ...(opts.headers ?? {}) },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new MediaGenError(err instanceof Error ? err.message : String(err), { retryable: true });
  }
  await ensureOk(res, opts.label);
  return res.json().catch(() => undefined);
}

/** POST multipart/form-data (do not set content-type — fetch adds the boundary). */export async function postForm(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  form: FormData,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; label: string },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { ...(opts.headers ?? {}) },
      body: form,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new MediaGenError(err instanceof Error ? err.message : String(err), { retryable: true });
  }
  await ensureOk(res, opts.label);
  return res;
}

/** Download a provider image URL into validated bytes (URLs expire). */
export async function fetchImageBytes(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; fallbackMime?: string; label?: string } = {},
): Promise<MediaGeneratedImage> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new MediaGenError(err instanceof Error ? err.message : String(err), { retryable: true });
  }
  await ensureOk(res, opts.label ?? "Image download");
  const bytes = new Uint8Array(await res.arrayBuffer());
  return toGeneratedImage(bytes, res.headers.get("content-type") ?? undefined, opts.fallbackMime);
}

/** Validate + wrap raw bytes as a generated image (mime sniffing, dimensions). */
export function toGeneratedImage(
  bytes: Uint8Array,
  headerMime?: string,
  fallbackMime?: string,
): MediaGeneratedImage {
  if (bytes.byteLength === 0) {
    throw new MediaGenError("Provider returned an empty image.", { retryable: false });
  }
  const mime = pickMime(headerMime, fallbackMime, bytes);
  if (!mime.startsWith("image/") || (mime !== "image/svg+xml" && mime !== "image/svg" && imageDimensions(bytes, mime) === undefined)) {
    throw new MediaGenError(`Provider returned a non-image payload (${mime}).`, { retryable: false });
  }
  return { mime, ext: extForMime(mime), bytes };
}

/** Decode a base64 image body into bytes. */
export function decodeB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Encode bytes as base64 (no data-URL prefix). */
export function encodeB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Build a `data:` URL for inline reference images. */
export function toDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime.length > 0 ? mime : "image/png"};base64,${encodeB64(bytes)}`;
}

/**
 * Wrap bytes in a Blob for multipart uploads. The cast keeps this compatible
 * with both the Bun/node and DOM `BlobPart` typings (a `Uint8Array`'s backing
 * buffer is `ArrayBufferLike`, which `lib.dom` widens to `ArrayBuffer`).
 */
export function bytesToBlob(bytes: Uint8Array, mime: string): Blob {
  return new Blob([bytes as unknown as never], { type: mime });
}

/** Map a text/format param to an image mime. */
export function mimeFromFormat(format: unknown): string {
  switch (format) {
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

/** File extension for an image mime. */
export function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

/** Magic-byte mime sniff (png/jpeg/gif/webp), for providers that omit it. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function pickMime(headerMime: string | undefined, fallback: string | undefined, bytes: Uint8Array): string {
  const header = headerMime !== undefined && headerMime.startsWith("image/") ? headerMime.split(";")[0]!.trim() : undefined;
  return header ?? sniffImageMime(bytes) ?? fallback ?? "image/png";
}

/** Abort-aware sleep (rejects with a non-retryable cancellation error). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new MediaGenError("Generation cancelled.", { retryable: false }));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new MediaGenError("Generation cancelled.", { retryable: false }));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One poll iteration's outcome. */
export interface PollState<T> {
  done: boolean;
  value?: T;
  error?: string;
  retryable?: boolean;
}

export interface PollOptions {
  /** Aborts the wait (job timeout / cancellation). */
  signal: AbortSignal;
  /** Wall-clock budget; keep below `config.jobs.timeoutMs` (default 180s). */
  timeoutMs?: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  label?: string;
}

/**
 * Poll `fetchStatus` until it reports done, backing off 1s→5s. Retryable
 * status errors are swallowed and retried; `signal` aborts promptly.
 */
export async function pollUntil<T>(
  fetchStatus: () => Promise<PollState<T>>,
  opts: PollOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 150_000;
  const maxInterval = opts.maxIntervalMs ?? 5_000;
  const label = opts.label ?? "Generation";
  let interval = opts.intervalMs ?? 1_000;
  const startedAt = Date.now();
  for (;;) {
    if (opts.signal.aborted) throw new MediaGenError("Generation cancelled.", { retryable: false });
    let state: PollState<T>;
    try {
      state = await fetchStatus();
    } catch (err) {
      if (err instanceof MediaGenError && err.retryable) {
        await sleep(interval, opts.signal);
        interval = Math.min(Math.round(interval * 1.5), maxInterval);
        continue;
      }
      throw err;
    }
    if (state.done) {
      if (state.value !== undefined) return state.value;
      throw new MediaGenError(state.error ?? `${label} failed.`, { retryable: state.retryable ?? false });
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new MediaGenError(`${label} timed out waiting for the provider.`, { retryable: true });
    }
    await sleep(interval, opts.signal);
    interval = Math.min(Math.round(interval * 1.5), maxInterval);
  }
}
