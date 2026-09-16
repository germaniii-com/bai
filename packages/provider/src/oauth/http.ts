/** Minimal HTTP helpers for OAuth endpoints (form/json, timeouts, signals). */

export interface HttpOpts {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or `{ _text }` when the body is not JSON. */
  data: Record<string, unknown>;
  text: string;
}

/** OAuth endpoint failure with the parsed error code when the provider sent one. */
export class OAuthHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "OAuthHttpError";
  }
}

function encodeForm(body: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

async function request(
  url: string,
  init: RequestInit,
  opts: HttpOpts,
  parse: boolean,
): Promise<HttpResponse> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  const onAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    if (parse && text.length > 0) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed !== null && typeof parsed === "object") data = parsed as Record<string, unknown>;
        else data = { _value: parsed };
      } catch {
        data = { _text: text };
      }
    } else if (text.length > 0) {
      data = { _text: text };
    }
    return { status: res.status, ok: res.ok, data, text };
  } finally {
    clearTimeout(timeout);
    if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
  }
}

export function postForm(
  url: string,
  body: Record<string, string | number | boolean | undefined>,
  opts: HttpOpts = {},
): Promise<HttpResponse> {
  return request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...(opts.headers ?? {}) },
      body: encodeForm(body),
    },
    opts,
    true,
  );
}

export function postJson(url: string, body: unknown, opts: HttpOpts = {}): Promise<HttpResponse> {
  return request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
    },
    opts,
    true,
  );
}

export function getJson(url: string, opts: HttpOpts = {}): Promise<HttpResponse> {
  return request(
    url,
    { method: "GET", headers: { Accept: "application/json", ...(opts.headers ?? {}) } },
    opts,
    true,
  );
}

export function getText(url: string, opts: HttpOpts = {}): Promise<HttpResponse> {
  return request(url, { method: "GET", headers: { Accept: "text/plain", ...(opts.headers ?? {}) } }, opts, false);
}

/** Throw an OAuthHttpError carrying the provider's error code when non-2xx. */
export function ensureOk(res: HttpResponse, what: string): void {
  if (res.ok) return;
  const err = res.data.error;
  const code =
    typeof err === "string"
      ? err
      : err !== null && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
        ? ((err as { code: string }).code)
        : typeof res.data.error_code === "string"
          ? res.data.error_code
          : undefined;
  const message =
    (typeof res.data.error_description === "string" && res.data.error_description) ||
    (err !== null && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : undefined) ||
    (typeof res.data._text === "string" && res.data._text.slice(0, 200)) ||
    `${what} failed (HTTP ${res.status})`;
  throw new OAuthHttpError(message, res.status, code);
}
