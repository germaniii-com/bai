/**
 * Reference/source input resolution + provider upload helpers.
 *
 * A video workflow's inputs are role-tagged `VideoInput`s (a stored bai asset
 * or an external URL). Adapters resolve them to bytes/URLs here, then either
 * inline them (base64 / data-URL) or — when the vendor requires a hosted
 * reference — upload through a stateless helper. Uploads are per-job and never
 * persisted: every vendor's upload refs expire (Runway 24h, Gemini 48h, fal
 * configurable, Replicate ~1h).
 */

import type { VideoInput, VideoRole } from "@bai/shared";
import { MediaGenError, type MediaGenContext } from "./adapter";
import { bytesToBlob, encodeB64, toDataUrl } from "./http";

/** One resolved input: bytes (stored asset) and/or a URL (external). */
export interface ResolvedInput {
  role: VideoRole;
  mime: string;
  bytes?: Uint8Array;
  url?: string;
  tag?: string;
  timestampSeconds?: number;
}

/** Resolve role-tagged request inputs against stored assets. */
export function resolveInputs(inputs: VideoInput[] | undefined, ctx: MediaGenContext): ResolvedInput[] {
  const out: ResolvedInput[] = [];
  for (const input of inputs ?? []) {
    if (input.assetId !== undefined) {
      const asset = ctx.readAsset(input.assetId);
      if (asset === undefined) continue;
      out.push({
        role: input.role,
        mime: asset.mime,
        bytes: asset.bytes,
        ...(input.tag !== undefined ? { tag: input.tag } : {}),
        ...(input.timestampSeconds !== undefined ? { timestampSeconds: input.timestampSeconds } : {}),
      });
    } else if (input.url !== undefined && input.url.length > 0) {
      out.push({
        role: input.role,
        mime: "application/octet-stream",
        url: input.url,
        ...(input.tag !== undefined ? { tag: input.tag } : {}),
        ...(input.timestampSeconds !== undefined ? { timestampSeconds: input.timestampSeconds } : {}),
      });
    }
  }
  return out;
}

export function inputsByRole(inputs: ResolvedInput[], role: VideoRole): ResolvedInput[] {
  return inputs.filter((i) => i.role === role);
}

export function firstInput(inputs: ResolvedInput[], role: VideoRole): ResolvedInput | undefined {
  return inputs.find((i) => i.role === role);
}

/** A required input, or a clear non-retryable error naming the role. */
export function requireInput(inputs: ResolvedInput[], role: VideoRole): ResolvedInput {
  const found = firstInput(inputs, role);
  if (found === undefined || (found.bytes === undefined && found.url === undefined)) {
    throw new MediaGenError(`This workflow needs a ${role.replace(/_/g, " ")}.`, { retryable: false });
  }
  return found;
}

/** Bytes for an input (throws when only a URL is available). */
export function inputBytes(input: ResolvedInput): Uint8Array {
  if (input.bytes === undefined) {
    throw new MediaGenError(
      `This provider needs local bytes for a ${input.role.replace(/_/g, " ")} (a hosted URL was given).`,
      { retryable: false },
    );
  }
  return input.bytes;
}

/** Data URL for an input (bytes preferred; an existing URL passes through). */
export function inputDataUrl(input: ResolvedInput): string {
  if (input.bytes !== undefined) return toDataUrl(input.mime, input.bytes);
  if (input.url !== undefined) return input.url;
  throw new MediaGenError(`Empty ${input.role.replace(/_/g, " ")} input.`, { retryable: false });
}

/** Raw base64 for an input's bytes (throws when only a URL is available). */
export function inputBase64(input: ResolvedInput): string {
  return encodeB64(inputBytes(input));
}

/** https URL for an input (an external URL passes through). */
export function inputHttpsUrl(input: ResolvedInput): string {
  if (input.url !== undefined && input.url.length > 0) return input.url;
  throw new MediaGenError(
    `This provider only accepts a hosted HTTPS URL for a ${input.role.replace(/_/g, " ")}.`,
    { retryable: false },
  );
}

// --- provider uploaders -----------------------------------------------------

/** fal.ai CDN storage upload → a durable https `file_url`. */
export async function uploadFalFile(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  bytes: Uint8Array,
  mime: string,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const initiate = await fetchJson(fetchImpl, "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
    method: "POST",
    headers: { authorization: `Key ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ content_type: mime, file_name: name }),
    ...(signal !== undefined ? { signal } : {}),
  }, "fal.ai upload");
  const fileUrl = str(initiate, "file_url");
  const uploadUrl = str(initiate, "upload_url");
  if (fileUrl === undefined || uploadUrl === undefined) {
    throw new MediaGenError("fal.ai did not return upload URLs.", { retryable: false });
  }
  await putBytes(fetchImpl, uploadUrl, bytes, mime, signal, "fal.ai upload");
  return fileUrl;
}

/** Runway ephemeral upload → a `runway://` uri usable in request fields. */
export async function uploadRunwayFile(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  baseUrl: string,
  bytes: Uint8Array,
  mime: string,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = baseUrl.replace(/\/+$/, "");
  const created = await fetchJson(fetchImpl, `${base}/v1/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "x-runway-version": "2024-11-06",
      "content-type": "application/json",
    },
    body: JSON.stringify({ filename: name, type: "ephemeral" }),
    ...(signal !== undefined ? { signal } : {}),
  }, "Runway upload");
  const uploadUrl = str(created, "uploadUrl") ?? str(created, "upload_url");
  const id = str(created, "id");
  const uri = str(created, "uploadUri") ?? str(created, "uri");
  if (uri !== undefined) return uri;
  if (uploadUrl !== undefined && id !== undefined) {
    await putBytes(fetchImpl, uploadUrl, bytes, mime, signal, "Runway upload");
    return id.startsWith("runway://") ? id : `runway://${id}`;
  }
  throw new MediaGenError("Runway did not return an upload target.", { retryable: false });
}

/** Replicate Files API upload → a signed https URL for large inputs. */
export async function uploadReplicateFile(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  bytes: Uint8Array,
  mime: string,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("content", bytesToBlob(bytes, mime), name);
  const res = await fetchImpl("https://api.replicate.com/v1/files", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok) {
    throw new MediaGenError(`Replicate upload failed (${res.status}).`, {
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
    });
  }
  const json = (await res.json().catch(() => undefined)) as
    | { urls?: { get?: unknown }; url?: unknown }
    | undefined;
  const url = str(json, "url") ?? (typeof json?.urls === "object" && json.urls !== null ? str(json.urls, "get") : undefined);
  if (url === undefined) throw new MediaGenError("Replicate did not return a file URL.", { retryable: false });
  return url;
}

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    if (init.signal?.aborted === true) throw err;
    throw new MediaGenError(err instanceof Error ? err.message : String(err), { retryable: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MediaGenError(text.length > 0 ? text.slice(0, 300) : `${label} failed (${res.status})`, {
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
    });
  }
  const json = await res.json().catch(() => undefined);
  return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
}

async function putBytes(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  bytes: Uint8Array,
  mime: string,
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "PUT",
      headers: { "content-type": mime },
      body: bytes as unknown as RequestInit["body"],
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted === true) throw err;
    throw new MediaGenError(err instanceof Error ? err.message : String(err), { retryable: true });
  }
  if (!res.ok) {
    throw new MediaGenError(`${label} PUT failed (${res.status}).`, {
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
    });
  }
}

function str(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
