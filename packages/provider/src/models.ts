import type { RemoteModelInfo } from "@bai/shared";

/**
 * Live model discovery for OpenAI-compatible endpoints (`GET {baseUrl}/models`).
 *
 * Custom providers declare their models explicitly in config, but the web form
 * and the TUI wizard fetch the endpoint's own list so the user picks from
 * reality instead of typing ids. Keyless local endpoints (Ollama, LM Studio)
 * work with no key; keyed gateways send `Authorization: Bearer`.
 */

export const REMOTE_MODELS_TIMEOUT_MS = 10_000;
const ERROR_SNIPPET_MAX = 200;

export interface FetchRemoteModelsOpts {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * GET `{baseUrl}/models` and normalize the response. Accepts the OpenAI shape
 * (`{ data: [{ id, … }] }`), the `{ models: […] }` variant some gateways use,
 * and a bare array; entries may be objects (`id`/`model` + optional `name`) or
 * plain strings. Returns deduped, id-sorted models. Throws on transport
 * errors and non-2xx (with the status and a body snippet).
 */
export async function fetchRemoteModels(opts: FetchRemoteModelsOpts): Promise<RemoteModelInfo[]> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? REMOTE_MODELS_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(opts.apiKey !== undefined && opts.apiKey.length > 0 ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        ...(opts.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const snippet = text.length > 0 ? ` — ${text.slice(0, ERROR_SNIPPET_MAX)}` : "";
      throw new Error(`list models failed: HTTP ${res.status}${snippet}`);
    }
    const json = (await res.json().catch(() => undefined)) as unknown;
    return normalizeRemoteModels(json);
  } finally {
    clearTimeout(timeout);
    if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
  }
}

/** Normalize the vendor shapes to `RemoteModelInfo[]` (drops malformed rows). */
export function normalizeRemoteModels(json: unknown): RemoteModelInfo[] {
  const raw: unknown =
    json !== null &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    Array.isArray((json as { data?: unknown }).data)
      ? (json as { data: unknown }).data
      : json !== null &&
          typeof json === "object" &&
          !Array.isArray(json) &&
          Array.isArray((json as { models?: unknown }).models)
        ? (json as { models: unknown }).models
        : Array.isArray(json)
          ? json
          : [];
  const seen = new Set<string>();
  const out: RemoteModelInfo[] = [];
  for (const entry of raw as unknown[]) {
    const id =
      typeof entry === "string"
        ? entry
        : entry !== null && typeof entry === "object"
          ? ((entry as { id?: unknown }).id ?? (entry as { model?: unknown }).model)
          : undefined;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const name =
      entry !== null && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
        ? ((entry as { name: string }).name as string)
        : undefined;
    out.push(name !== undefined && name.length > 0 && name !== id ? { id, name } : { id });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
