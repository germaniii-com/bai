/**
 * Shared transport helpers specific to video adapters (the generic JSON/
 * multipart/poll helpers live in `http.ts`). Providers return expiring result
 * URLs, so every adapter downloads bytes inside `generate()` through
 * {@link fetchVideoBytes}; {@link toGeneratedVideo} validates the payload and
 * probes dimensions/duration.
 */

import { MediaGenError } from "./adapter";
import { ensureOk } from "./http";
import type { MediaGeneratedVideo } from "./video-adapter";
import { sniffVideoMime, videoExtForMime, videoProbe } from "./video-dimensions";

export interface FetchVideoOpts {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  fallbackMime?: string;
  label?: string;
}

/** Download a provider video URL into validated bytes (URLs expire). */
export async function fetchVideoBytes(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  opts: FetchVideoOpts = {},
): Promise<MediaGeneratedVideo> {
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
  await ensureOk(res, opts.label ?? "Video download");
  const bytes = new Uint8Array(await res.arrayBuffer());
  return toGeneratedVideo(bytes, res.headers.get("content-type") ?? undefined, opts.fallbackMime);
}

/** Validate + wrap raw video bytes (mime sniffing, container probe). */
export function toGeneratedVideo(
  bytes: Uint8Array,
  headerMime?: string,
  fallbackMime?: string,
): MediaGeneratedVideo {
  if (bytes.byteLength === 0) {
    throw new MediaGenError("Provider returned an empty video.", { retryable: false });
  }
  const mime = pickVideoMime(headerMime, fallbackMime, bytes);
  if (!mime.startsWith("video/")) {
    throw new MediaGenError(`Provider returned a non-video payload (${mime}).`, { retryable: false });
  }
  const probe = videoProbe(bytes, mime);
  return {
    mime,
    ext: videoExtForMime(mime),
    bytes,
    ...(probe?.width !== undefined ? { width: probe.width } : {}),
    ...(probe?.height !== undefined ? { height: probe.height } : {}),
    ...(probe?.durationSeconds !== undefined ? { durationSeconds: probe.durationSeconds } : {}),
  };
}

function pickVideoMime(headerMime: string | undefined, fallback: string | undefined, bytes: Uint8Array): string {
  const header =
    headerMime !== undefined && headerMime.startsWith("video/") ? headerMime.split(";")[0]!.trim() : undefined;
  return header ?? sniffVideoMime(bytes) ?? fallback ?? "video/mp4";
}
