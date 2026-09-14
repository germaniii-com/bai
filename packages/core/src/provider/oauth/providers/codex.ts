import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { OAuthFlowSpec, OAuthFlowContext, OAuthRefreshContext, OAuthTokens } from "../types";
import { ensureOk, postForm } from "../http";
import { runRedirectFlow } from "../redirect";
import { decodeJwtClaims, jwtExpiryMs } from "../jwt";

/**
 * OpenAI ChatGPT / Codex — device-code login at auth.openai.com.
 *
 * The Codex device endpoints are non-standard: the user-code endpoint returns
 * `device_auth_id`, the poll returns `authorization_code` + `code_verifier`
 * (server-generated PKCE), and 403/404 means "still waiting". Inference runs
 * over the Responses API at chatgpt.com/backend-api/codex.
 */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_DEVICE_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** `chatgpt_account_id` claim used for the ChatGPT-Account-ID header. */
export function chatgptAccountId(accessToken: string): string | undefined {
  const claims = decodeJwtClaims(accessToken);
  const auth = claims?.["https://api.openai.com/auth"];
  if (auth !== null && typeof auth === "object") {
    const id = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

async function login(ctx: OAuthFlowContext): Promise<OAuthTokens> {
  // Prefer an existing Codex CLI login before a fresh device flow.
  const imported = await importCodex();
  if (imported !== undefined) return imported;

  const codeRes = await postForm(
    `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
    { client_id: CODEX_CLIENT_ID },
    { fetch: ctx.fetch, signal: ctx.signal },
  );
  ensureOk(codeRes, "ChatGPT device authorization");
  const userCode = codeRes.data.user_code;
  const deviceAuthId = codeRes.data.device_auth_id;
  if (typeof userCode !== "string" || typeof deviceAuthId !== "string") {
    throw new Error("ChatGPT device authorization response missing fields");
  }
  const expiresIn = typeof codeRes.data.expires_in === "number" ? codeRes.data.expires_in : 900;
  const interval = typeof codeRes.data.interval === "number" ? codeRes.data.interval : 5;
  ctx.progress({
    status: "pending",
    userCode,
    verificationUri: CODEX_DEVICE_URL,
    expiresAt: ctx.now() + expiresIn * 1000,
  });

  const deadline = ctx.now() + expiresIn * 1000;
  let wait = Math.max(3, Math.floor(interval)) * 1000;
  let authorizationCode = "";
  let codeVerifier = "";
  while (true) {
    if (ctx.signal.aborted) throw new Error("login cancelled");
    if (ctx.now() >= deadline) throw new Error("ChatGPT device login expired");
    await ctx.sleep(wait);
    const poll = await postForm(
      `${CODEX_ISSUER}/api/accounts/deviceauth/token`,
      { device_auth_id: deviceAuthId, user_code: userCode },
      { fetch: ctx.fetch, signal: ctx.signal },
    );
    if (poll.ok) {
      authorizationCode = typeof poll.data.authorization_code === "string" ? poll.data.authorization_code : "";
      codeVerifier = typeof poll.data.code_verifier === "string" ? poll.data.code_verifier : "";
      if (authorizationCode.length === 0 || codeVerifier.length === 0) {
        throw new Error("ChatGPT device login returned no authorization code");
      }
      break;
    }
    if (poll.status === 403 || poll.status === 404) continue;
    ensureOk(poll, "ChatGPT device poll");
  }

  const token = await postForm(
    CODEX_TOKEN_URL,
    {
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: CODEX_REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    },
    { fetch: ctx.fetch, signal: ctx.signal, headers: { "User-Agent": "bai-cli" } },
  );
  ensureOk(token, "ChatGPT token exchange");
  return mapCodexTokens(token.data);
}

export function mapCodexTokens(data: Record<string, unknown>): OAuthTokens {
  const access = typeof data.access_token === "string" ? data.access_token : "";
  if (access.length === 0) throw new Error("ChatGPT token exchange returned no access_token");
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
  const expiresAt = jwtExpiryMs(access);
  const accountId = chatgptAccountId(access);
  return {
    access,
    ...(refresh !== undefined ? { refresh } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
  };
}

async function refresh(
  tokens: { access: string; refresh?: string; idToken?: string },
  ctx: OAuthRefreshContext,
): Promise<OAuthTokens> {
  if (tokens.refresh === undefined || tokens.refresh.length === 0) {
    throw new Error("ChatGPT account has no refresh token; reconnect required");
  }
  const res = await postForm(
    CODEX_TOKEN_URL,
    { grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: CODEX_CLIENT_ID },
    {
      fetch: ctx.fetch,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      headers: { "User-Agent": "bai-cli" },
    },
  );
  ensureOk(res, "ChatGPT token refresh");
  // Preserve the old refresh token when the server does not rotate it.
  return mapCodexTokens({ ...res.data, refresh_token: res.data.refresh_token ?? tokens.refresh });
}

/** Import tokens from the Codex CLI (`~/.codex/auth.json`). */
async function importCodex(): Promise<OAuthTokens | undefined> {
  const home = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const file = path.join(home, "auth.json");
  if (!existsSync(file)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { tokens?: { access_token?: unknown; refresh_token?: unknown } };
    const access = doc.tokens?.access_token;
    const refresh = doc.tokens?.refresh_token;
    if (typeof access !== "string" || access.length === 0) return undefined;
    const expiresAt = jwtExpiryMs(access);
    const accountId = chatgptAccountId(access);
    return {
      access,
      ...(typeof refresh === "string" ? { refresh } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(accountId !== undefined ? { accountId } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Browser redirect flow: OpenAI's registered loopback redirect is
 * `http://localhost:1455/auth/callback`. Opens the ChatGPT login page; the
 * callback exchanges the code with PKCE.
 */
async function redirectLogin(ctx: OAuthFlowContext): Promise<OAuthTokens> {
  return runRedirectFlow({
    port: 1455,
    path: "/auth/callback",
    host: "localhost",
    authorizeUrl: (redirectUri, pkce) => {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CODEX_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: "openid profile email offline_access",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        state: pkce.state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
      });
      return `${CODEX_ISSUER}/oauth/authorize?${params.toString()}`;
    },
    exchange: async (code, c) => {
      const res = await postForm(
        CODEX_TOKEN_URL,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: c.redirectUri,
          client_id: CODEX_CLIENT_ID,
          code_verifier: c.verifier,
        },
        { fetch: ctx.fetch, signal: ctx.signal, headers: { "User-Agent": "bai-cli" } },
      );
      ensureOk(res, "ChatGPT token exchange");
      return mapCodexTokens(res.data);
    },
    signal: ctx.signal,
    now: ctx.now,
    progress: ctx.progress,
  });
}

export const codexSpec: OAuthFlowSpec = {
  id: "openai-codex",
  name: "ChatGPT (Codex)",
  method: "device_code",
  hint: "Sign in with your ChatGPT account",
  accountId: "chatgpt",
  run: login,
  redirect: redirectLogin,
  refresh,
  import: importCodex,
};
