import type { OAuthFlowSpec, OAuthFlowContext, OAuthRefreshContext, OAuthTokens } from "../types";
import { ensureOk, postForm, type HttpResponse } from "../http";
import { pkcePair, randomState } from "../pkce";

/** MiniMax — `user_code` grant with PKCE; inference on the Anthropic wire. */
export const MINIMAX_CLIENT_ID = "78257093-7e40-4613-99e0-527b14b39113";
export const MINIMAX_SCOPE = "group_id profile model.completion";
export const MINIMAX_BASE = "https://api.minimax.io";
export const MINIMAX_USER_CODE_GRANT = "urn:ietf:params:oauth:grant-type:user_code";

function resolveExpiry(expiredIn: unknown, now: number): number | undefined {
  if (typeof expiredIn !== "number" || !Number.isFinite(expiredIn)) return undefined;
  // > half of the current epoch means the provider sent unix-ms; else TTL seconds.
  return expiredIn > now / 2 ? expiredIn : now + expiredIn * 1000;
}

function mapTokens(data: Record<string, unknown>, now: number): OAuthTokens {
  const access = typeof data.access_token === "string" ? data.access_token : "";
  if (access.length === 0) throw new Error("MiniMax login returned no access_token");
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
  const expiresAt = resolveExpiry(data.expired_in, now);
  return {
    access,
    ...(refresh !== undefined ? { refresh } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

async function login(ctx: OAuthFlowContext): Promise<OAuthTokens> {
  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const codeRes = await postForm(
    `${MINIMAX_BASE}/oauth/code`,
    {
      response_type: "code",
      client_id: MINIMAX_CLIENT_ID,
      scope: MINIMAX_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    },
    { fetch: ctx.fetch, signal: ctx.signal },
  );
  ensureOk(codeRes, "MiniMax authorization");
  const userCode = codeRes.data.user_code;
  const verificationUri = codeRes.data.verification_uri;
  if (typeof userCode !== "string") throw new Error("MiniMax response missing user_code");
  const expiresAt = resolveExpiry(codeRes.data.expired_in, ctx.now());
  ctx.progress({
    status: "pending",
    userCode,
    ...(typeof verificationUri === "string" ? { verificationUri } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });

  const deadline = expiresAt ?? ctx.now() + 10 * 60 * 1000;
  const interval = 2000;
  while (true) {
    if (ctx.signal.aborted) throw new Error("login cancelled");
    if (ctx.now() >= deadline) throw new Error("MiniMax login expired");
    await ctx.sleep(interval);
    const poll = await postForm(
      `${MINIMAX_BASE}/oauth/token`,
      {
        grant_type: MINIMAX_USER_CODE_GRANT,
        client_id: MINIMAX_CLIENT_ID,
        user_code: userCode,
        code_verifier: verifier,
      },
      { fetch: ctx.fetch, signal: ctx.signal },
    );
    if (poll.ok && typeof poll.data.access_token === "string") {
      return mapTokens(poll.data, ctx.now());
    }
    if (poll.ok && poll.data.status === "error") {
      throw new Error(readMinimaxError(poll));
    }
    if (!poll.ok) ensureOk(poll, "MiniMax token poll");
  }
}

function readMinimaxError(res: HttpResponse): string {
  const base = res.data.base_resp;
  if (base !== null && typeof base === "object" && typeof (base as { status_msg?: unknown }).status_msg === "string") {
    return (base as { status_msg: string }).status_msg;
  }
  return "MiniMax login was rejected";
}

async function refresh(
  tokens: { access: string; refresh?: string; idToken?: string },
  ctx: OAuthRefreshContext,
): Promise<OAuthTokens> {
  if (tokens.refresh === undefined || tokens.refresh.length === 0) {
    throw new Error("MiniMax account has no refresh token; reconnect required");
  }
  const res = await postForm(
    `${MINIMAX_BASE}/oauth/token`,
    { grant_type: "refresh_token", client_id: MINIMAX_CLIENT_ID, refresh_token: tokens.refresh },
    { fetch: ctx.fetch, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
  );
  ensureOk(res, "MiniMax token refresh");
  return mapTokens({ ...res.data, refresh_token: res.data.refresh_token ?? tokens.refresh }, Date.now());
}

export const minimaxSpec: OAuthFlowSpec = {
  id: "minimax-oauth",
  name: "MiniMax (OAuth)",
  method: "device_code",
  hint: "Sign in with your MiniMax account",
  accountId: "minimax",
  run: login,
  refresh,
};
