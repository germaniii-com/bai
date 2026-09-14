import { execFileSync } from "node:child_process";
import type { OAuthFlowSpec, OAuthFlowContext, OAuthRefreshContext, OAuthTokens } from "../types";
import { ensureOk, getJson } from "../http";
import { runDeviceCode } from "../device";

/** GitHub Copilot — GitHub device-code, then exchange for a Copilot API token. */
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const COPILOT_GITHUB_HOST = process.env.COPILOT_GH_HOST ?? "github.com";
export const COPILOT_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
export const COPILOT_EDITOR_VERSION = "vscode/1.104.1";
export const COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";

/** Exchange a raw GitHub OAuth token for a short-lived Copilot API token. */
export async function exchangeCopilotToken(
  rawToken: string,
  ctx: { fetch: typeof globalThis.fetch; signal?: AbortSignal },
): Promise<OAuthTokens> {
  const res = await getJson(COPILOT_EXCHANGE_URL, {
    fetch: ctx.fetch,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    headers: {
      Authorization: `token ${rawToken}`,
      "User-Agent": COPILOT_USER_AGENT,
      "Editor-Version": COPILOT_EDITOR_VERSION,
    },
  });
  ensureOk(res, "Copilot token exchange");
  const apiToken = typeof res.data.token === "string" ? res.data.token : "";
  if (apiToken.length === 0) throw new Error("Copilot token exchange returned no token");
  const expiresAt = typeof res.data.expires_at === "number" ? res.data.expires_at * 1000 : Date.now() + 30 * 60 * 1000;
  const endpoints = res.data.endpoints;
  const baseUrl =
    endpoints !== null && typeof endpoints === "object" && typeof (endpoints as { api?: unknown }).api === "string"
      ? (endpoints as { api: string }).api
      : undefined;
  return {
    access: apiToken,
    // Keep the raw GitHub token so refresh can re-exchange.
    refresh: rawToken,
    expiresAt,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

async function login(ctx: OAuthFlowContext): Promise<OAuthTokens> {
  // Prefer an existing GitHub token (env / gh CLI) before device login.
  const existing = readRawGithubToken();
  if (existing !== undefined) {
    try {
      return await exchangeCopilotToken(existing, { fetch: ctx.fetch, signal: ctx.signal });
    } catch {
      // Fall through to device login when the token is stale/unsupported.
    }
  }
  const raw = await runDeviceCode({
    deviceEndpoint: `https://${COPILOT_GITHUB_HOST}/login/device/code`,
    tokenEndpoint: `https://${COPILOT_GITHUB_HOST}/login/oauth/access_token`,
    clientId: COPILOT_CLIENT_ID,
    scope: "read:user",
    fetch: ctx.fetch,
    signal: ctx.signal,
    now: ctx.now,
    sleep: ctx.sleep,
    progress: ctx.progress,
    headers: { "User-Agent": "bai-cli" },
  });
  const github = raw.access ?? "";
  if (github.length === 0) throw new Error("GitHub device login returned no token");
  return exchangeCopilotToken(github, { fetch: ctx.fetch, signal: ctx.signal });
}

async function refresh(
  tokens: { access: string; refresh?: string; idToken?: string },
  ctx: OAuthRefreshContext,
): Promise<OAuthTokens> {
  if (tokens.refresh === undefined || tokens.refresh.length === 0) {
    throw new Error("Copilot account has no GitHub token; reconnect required");
  }
  return exchangeCopilotToken(tokens.refresh, ctx);
}

const ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

/** Read a raw GitHub token from env, or `gh auth token` when available. */
export function readRawGithubToken(): string | undefined {
  for (const name of ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0 && !value.startsWith("ghp_")) return value;
  }
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    }).trim();
    if (out.length > 0 && !out.startsWith("ghp_")) return out;
  } catch {
    // gh not installed / not logged in — no import.
  }
  return undefined;
}

export const copilotSpec: OAuthFlowSpec = {
  id: "copilot",
  name: "GitHub Copilot",
  method: "device_code",
  hint: "Sign in with GitHub",
  accountId: "github",
  run: login,
  refresh,
};
