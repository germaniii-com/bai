import type { OAuthFlowSpec, OAuthFlowContext, OAuthRefreshContext, OAuthTokens } from "../types";
import { ensureOk, getJson, postForm } from "../http";
import { runDeviceCode } from "../device";
import { jwtExpiryMs } from "../jwt";

/** xAI Grok — OIDC discovery + device-code; inference over the Responses API. */
export const XAI_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";

interface Discovery {
  authorizationEndpoint?: string;
  tokenEndpoint: string;
}

export async function discoverXai(ctx: { fetch: typeof globalThis.fetch; signal?: AbortSignal }): Promise<Discovery> {
  const res = await getJson(XAI_DISCOVERY_URL, {
    fetch: ctx.fetch,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  ensureOk(res, "xAI OIDC discovery");
  const tokenEndpoint = res.data.token_endpoint;
  if (typeof tokenEndpoint !== "string" || !isXaiHost(tokenEndpoint)) {
    // Fall back to the well-known endpoint when discovery is unavailable.
    return { tokenEndpoint: "https://auth.x.ai/oauth2/token" };
  }
  const authorizationEndpoint = typeof res.data.authorization_endpoint === "string" ? res.data.authorization_endpoint : undefined;
  return { tokenEndpoint, ...(authorizationEndpoint !== undefined ? { authorizationEndpoint } : {}) };
}

function isXaiHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "x.ai" || host.endsWith(".x.ai");
  } catch {
    return false;
  }
}

async function login(ctx: OAuthFlowContext): Promise<OAuthTokens> {
  const discovery = await discoverXai(ctx);
  return runDeviceCode({
    deviceEndpoint: XAI_DEVICE_CODE_URL,
    tokenEndpoint: discovery.tokenEndpoint,
    clientId: XAI_CLIENT_ID,
    scope: XAI_SCOPE,
    fetch: ctx.fetch,
    signal: ctx.signal,
    now: ctx.now,
    sleep: ctx.sleep,
    progress: ctx.progress,
  });
}

async function refresh(
  tokens: { access: string; refresh?: string; idToken?: string },
  ctx: OAuthRefreshContext,
): Promise<OAuthTokens> {
  if (tokens.refresh === undefined || tokens.refresh.length === 0) {
    throw new Error("xAI account has no refresh token; reconnect required");
  }
  const discovery = await discoverXai(ctx);
  const res = await postForm(
    discovery.tokenEndpoint,
    { grant_type: "refresh_token", client_id: XAI_CLIENT_ID, refresh_token: tokens.refresh },
    { fetch: ctx.fetch, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
  );
  ensureOk(res, "xAI token refresh");
  const access = typeof res.data.access_token === "string" ? res.data.access_token : "";
  if (access.length === 0) throw new Error("xAI refresh returned no access_token");
  const expiresIn = typeof res.data.expires_in === "number" ? res.data.expires_in : undefined;
  const expiresAt = jwtExpiryMs(access) ?? (expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined);
  return {
    access,
    refresh: typeof res.data.refresh_token === "string" ? res.data.refresh_token : tokens.refresh,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(typeof res.data.id_token === "string" ? { idToken: res.data.id_token } : {}),
  };
}

export const xaiSpec: OAuthFlowSpec = {
  id: "xai",
  name: "xAI (Grok)",
  method: "device_code",
  hint: "Sign in with your xAI / SuperGrok account",
  accountId: "grok",
  run: login,
  refresh,
};
