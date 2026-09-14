import type { OAuthProgress, OAuthTokens } from "./types";
import { ensureOk, postForm, type HttpResponse } from "./http";

/**
 * Generic RFC 8628 device-authorization flow. Covers Nous Portal, xAI, GitHub
 * Copilot and ChatGPT/Codex (which uses `device_auth_id` instead of
 * `device_code` and 403/404 for "pending" rather than an error code).
 */
export interface DeviceCodeOptions {
  deviceEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope?: string;
  headers?: Record<string, string>;
  /** Device-code response field carrying the device id (default "device_code"). */
  deviceCodeField?: string;
  /** Default verification URI when the response omits one. */
  fallbackVerificationUri?: string;
  /** Extra token-poll params (e.g. `code_verifier`, `device_auth_id`). */
  tokenParams?: (deviceCode: string, raw: Record<string, unknown>) => Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  now(): number;
  sleep(ms: number): Promise<void>;
  progress(update: OAuthProgress): void;
  /** Map the final token response to OAuthTokens. */
  mapTokens?: (data: Record<string, unknown>) => OAuthTokens;
  timeoutMs?: number;
}

const DEFAULT_MAP = (data: Record<string, unknown>): OAuthTokens => {
  const access = typeof data.access_token === "string" ? data.access_token : "";
  if (access.length === 0) throw new Error("device login returned no access_token");
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
  return {
    access,
    ...(refresh !== undefined ? { refresh } : {}),
    ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
  };
};

export async function runDeviceCode(opts: DeviceCodeOptions): Promise<OAuthTokens> {
  const deviceField = opts.deviceCodeField ?? "device_code";
  const res = await postForm(
    opts.deviceEndpoint,
    { client_id: opts.clientId, ...(opts.scope !== undefined ? { scope: opts.scope } : {}) },
    { ...(opts.headers !== undefined ? { headers: opts.headers } : {}), fetch: opts.fetch, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 20_000 },
  );
  ensureOk(res, "device authorization");
  const raw = res.data;
  const deviceCode = raw[deviceField];
  const userCode = raw.user_code;
  if (typeof deviceCode !== "string" || typeof userCode !== "string") {
    throw new Error("device authorization response missing code fields");
  }
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : 900;
  const verificationUri =
    typeof raw.verification_uri === "string" ? raw.verification_uri : opts.fallbackVerificationUri;
  const verificationUriComplete =
    typeof raw.verification_uri_complete === "string" ? raw.verification_uri_complete : undefined;

  opts.progress({
    status: "pending",
    userCode,
    ...(verificationUri !== undefined ? { verificationUri } : {}),
    ...(verificationUriComplete !== undefined ? { verificationUriComplete } : {}),
    expiresAt: opts.now() + expiresIn * 1000,
  });

  let intervalMs = clampInterval(typeof raw.interval === "number" ? raw.interval : 5);
  const deadline = opts.now() + expiresIn * 1000;

  while (true) {
    if (opts.signal.aborted) throw new Error("login cancelled");
    if (opts.now() >= deadline) throw new Error("device login expired");
    await opts.sleep(intervalMs);
    if (opts.signal.aborted) throw new Error("login cancelled");

    const extra = opts.tokenParams?.(deviceCode, raw) ?? {};
    const poll = await postForm(
      opts.tokenEndpoint,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: opts.clientId,
        [deviceField]: deviceCode,
        ...extra,
      },
      { ...(opts.headers !== undefined ? { headers: opts.headers } : {}), fetch: opts.fetch, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 20_000 },
    );

    if (poll.ok) {
      return (opts.mapTokens ?? DEFAULT_MAP)(poll.data);
    }
    // "Pending" is expressed either as a status (403/404 at ChatGPT) or an
    // OAuth error code in a 200/400 body.
    if (poll.status === 403 || poll.status === 404) continue;
    const code = errorCode(poll);
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalMs = clampInterval(Math.ceil(intervalMs / 1000) + 1);
      continue;
    }
    if (code === "expired_token") throw new Error("device login expired");
    if (code === "access_denied") throw new Error("device login was denied");
    ensureOk(poll, "device token");
    throw new Error(`device token failed (HTTP ${poll.status})`);
  }
}

function errorCode(res: HttpResponse): string | undefined {
  const err = res.data.error;
  if (typeof err === "string") return err;
  if (err !== null && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return undefined;
}

function clampInterval(seconds: number): number {
  const s = Number.isFinite(seconds) ? seconds : 5;
  return Math.min(Math.max(Math.floor(s), 1), 30) * 1000;
}
