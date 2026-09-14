import type { OAuthFlowSpec, OAuthFlowContext, OAuthRefreshContext, OAuthTokens } from "../types";
import { ensureOk, postForm } from "../http";
import { runDeviceCode } from "../device";
import { jwtExpiryMs } from "../jwt";

/** Nous Portal — RFC 8628 device-code; the access token is an invoke JWT. */
export const NOUS_PORTAL_URL = process.env.BAI_NOUS_PORTAL_URL ?? "https://portal.nousresearch.com";
export const NOUS_CLIENT_ID = process.env.BAI_NOUS_CLIENT_ID ?? "hermes-cli";
export const NOUS_SCOPE = "inference:invoke";

function mapNousTokens(data: Record<string, unknown>): OAuthTokens {
  const access = typeof data.access_token === "string" ? data.access_token : "";
  if (access.length === 0) throw new Error("Nous device login returned no access_token");
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
  const expiresAt = jwtExpiryMs(access);
  return {
    access,
    ...(refresh !== undefined ? { refresh } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

async function login(ctx: OAuthFlowContext): Promise<OAuthTokens> {
  return runDeviceCode({
    deviceEndpoint: `${NOUS_PORTAL_URL}/api/oauth/device/code`,
    tokenEndpoint: `${NOUS_PORTAL_URL}/api/oauth/token`,
    clientId: NOUS_CLIENT_ID,
    scope: NOUS_SCOPE,
    fetch: ctx.fetch,
    signal: ctx.signal,
    now: ctx.now,
    sleep: ctx.sleep,
    progress: ctx.progress,
    mapTokens: mapNousTokens,
  });
}

async function refresh(
  tokens: { access: string; refresh?: string; idToken?: string },
  ctx: OAuthRefreshContext,
): Promise<OAuthTokens> {
  if (tokens.refresh === undefined || tokens.refresh.length === 0) {
    throw new Error("Nous account has no refresh token; reconnect required");
  }
  const res = await postForm(
    `${NOUS_PORTAL_URL}/api/oauth/token`,
    { grant_type: "refresh_token", client_id: NOUS_CLIENT_ID },
    { fetch: ctx.fetch, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}), headers: { "x-nous-refresh-token": tokens.refresh } },
  );
  ensureOk(res, "Nous token refresh");
  return mapNousTokens({ ...res.data, refresh_token: res.data.refresh_token ?? tokens.refresh });
}

export const nousSpec: OAuthFlowSpec = {
  id: "nous",
  name: "Nous Portal",
  method: "device_code",
  hint: "Sign in to your Nous Portal account",
  accountId: "portal",
  run: login,
  refresh,
};
