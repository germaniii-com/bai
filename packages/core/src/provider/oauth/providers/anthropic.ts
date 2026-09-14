import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { OAuthFlowSpec, OAuthFlowContext, OAuthRefreshContext, OAuthTokens } from "../types";
import { ensureOk, postJson } from "../http";
import { pkcePair, randomState } from "../pkce";
import { runRedirectFlow } from "../redirect";

/**
 * Anthropic Claude Pro/Max — paste-code PKCE.
 *
 * The redirect URI is Anthropic's own console callback, so the user copies the
 * resulting `code#state` back. The token endpoint rejects `claude-code/*`
 * User-Agents (HTTP 429), so requests mirror the CLI's `axios/1.7.9`.
 */
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference";
export const ANTHROPIC_TOKEN_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];
const ANTHROPIC_TOKEN_UA = "axios/1.7.9";

export function buildAnthropicAuthorizeUrlFor(redirectUri: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: ANTHROPIC_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`;
}

/** Paste-code variant: Anthropic's hosted console callback. */
export function buildAnthropicAuthorizeUrl(challenge: string, state: string): string {
  return buildAnthropicAuthorizeUrlFor(ANTHROPIC_REDIRECT_URI, challenge, state);
}

async function login(ctx: OAuthFlowContext): Promise<OAuthTokens> {
  // Borrow an existing Claude Code / setup token first.
  const imported = importAnthropic();
  if (imported !== undefined) return imported;

  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const authorizeUrl = buildAnthropicAuthorizeUrl(challenge, state);
  ctx.progress({
    status: "awaiting_code",
    authorizeUrl,
    instructions: "Open the link, approve access, then paste the code shown (format code#state).",
  });

  const pasted = await ctx.waitForCode();
  const [code = "", receivedState = ""] = pasted.trim().split("#");
  if (code.length === 0) throw new Error("no authorization code submitted");
  if (receivedState !== state) throw new Error("OAuth state mismatch — request aborted");

  const body = {
    grant_type: "authorization_code",
    client_id: ANTHROPIC_CLIENT_ID,
    code,
    state: receivedState,
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    code_verifier: verifier,
  };
  const res = await postAnthropicToken(body, { fetch: ctx.fetch, signal: ctx.signal });
  return mapAnthropicTokens(res.data);
}

async function postAnthropicToken(
  body: Record<string, unknown>,
  ctx: { fetch: typeof globalThis.fetch; signal?: AbortSignal },
): Promise<{ data: Record<string, unknown> }> {
  let lastErr: unknown;
  for (const url of ANTHROPIC_TOKEN_URLS) {
    try {
      const res = await postJson(url, body, {
        fetch: ctx.fetch,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        headers: { "User-Agent": ANTHROPIC_TOKEN_UA },
      });
      ensureOk(res, "Anthropic token");
      return { data: res.data };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Anthropic token exchange failed");
}

function mapAnthropicTokens(data: Record<string, unknown>): OAuthTokens {
  const access = typeof data.access_token === "string" ? data.access_token : "";
  if (access.length === 0) throw new Error("Anthropic token response missing access_token");
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return {
    access,
    ...(refresh !== undefined ? { refresh } : {}),
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

async function refresh(
  tokens: { access: string; refresh?: string; idToken?: string },
  ctx: OAuthRefreshContext,
): Promise<OAuthTokens> {
  if (tokens.refresh === undefined || tokens.refresh.length === 0) {
    throw new Error("Anthropic account has no refresh token; reconnect required");
  }
  const res = await postAnthropicToken(
    { grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: ANTHROPIC_CLIENT_ID },
    ctx,
  );
  return mapAnthropicTokens({ ...res.data, refresh_token: res.data.refresh_token ?? tokens.refresh });
}

/** Import a Claude Code token from its credentials file or env vars. */
export function importAnthropic(): OAuthTokens | undefined {
  try {
    const file = path.join(homedir(), ".claude", ".credentials.json");
    if (existsSync(file)) {
      const doc = JSON.parse(readFileSync(file, "utf8")) as {
        claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
      };
      const oauth = doc.claudeAiOauth;
      if (oauth !== undefined && typeof oauth.accessToken === "string" && oauth.accessToken.length > 0) {
        return {
          access: oauth.accessToken,
          ...(typeof oauth.refreshToken === "string" ? { refresh: oauth.refreshToken } : {}),
          ...(typeof oauth.expiresAt === "number" ? { expiresAt: oauth.expiresAt } : {}),
        };
      }
    }
  } catch {
    // fall through to env
  }
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_TOKEN;
  if (envToken !== undefined && envToken.length > 0 && !envToken.startsWith("sk-ant-api")) {
    return { access: envToken };
  }
  return undefined;
}

/** Browser redirect flow — Claude Code's registered loopback is `localhost:54545/callback`. */
async function redirectLogin(ctx: OAuthFlowContext): Promise<OAuthTokens> {
  return runRedirectFlow({
    port: 54545,
    path: "/callback",
    host: "localhost",
    authorizeUrl: (redirectUri, pkce) => buildAnthropicAuthorizeUrlFor(redirectUri, pkce.challenge, pkce.state),
    exchange: async (code, c) => {
      const res = await postAnthropicToken(
        {
          grant_type: "authorization_code",
          client_id: ANTHROPIC_CLIENT_ID,
          code,
          state: c.state,
          redirect_uri: c.redirectUri,
          code_verifier: c.verifier,
        },
        { fetch: ctx.fetch, signal: ctx.signal },
      );
      return mapAnthropicTokens(res.data);
    },
    signal: ctx.signal,
    now: ctx.now,
    progress: ctx.progress,
  });
}

export const anthropicSpec: OAuthFlowSpec = {
  id: "anthropic",
  name: "Anthropic (Claude Pro/Max)",
  method: "paste_code",
  hint: "Sign in with a Claude subscription (or import Claude Code)",
  accountId: "claude",
  run: login,
  redirect: redirectLogin,
  refresh,
  import: async () => importAnthropic(),
};
