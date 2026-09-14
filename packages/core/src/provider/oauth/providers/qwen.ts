import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { OAuthFlowSpec, OAuthFlowContext, OAuthRefreshContext, OAuthTokens } from "../types";
import { ensureOk, postForm } from "../http";

/**
 * Qwen — no native Hermes/bai login; imports the Qwen CLI's credential file
 * (`~/.qwen/oauth_creds.json`) and refreshes it against chat.qwen.ai.
 */
export const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
export const QWEN_TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token";

export function qwenCredsPath(): string {
  return path.join(homedir(), ".qwen", "oauth_creds.json");
}

export function importQwen(): OAuthTokens | undefined {
  const file = qwenCredsPath();
  if (!existsSync(file)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expiry_date?: unknown;
      resource_url?: unknown;
    };
    if (typeof doc.access_token !== "string" || doc.access_token.length === 0) return undefined;
    return {
      access: doc.access_token,
      ...(typeof doc.refresh_token === "string" ? { refresh: doc.refresh_token } : {}),
      ...(typeof doc.expiry_date === "number" ? { expiresAt: doc.expiry_date } : {}),
    };
  } catch {
    return undefined;
  }
}

async function login(_ctx: OAuthFlowContext): Promise<OAuthTokens> {
  const imported = importQwen();
  if (imported === undefined) {
    throw new Error(
      `No Qwen credentials found at ${qwenCredsPath()} — run \`qwen auth qwen-oauth\` first, then reconnect.`,
    );
  }
  return imported;
}

async function refresh(
  tokens: { access: string; refresh?: string; idToken?: string },
  ctx: OAuthRefreshContext,
): Promise<OAuthTokens> {
  if (tokens.refresh === undefined || tokens.refresh.length === 0) {
    throw new Error("Qwen account has no refresh token; reconnect required");
  }
  const res = await postForm(
    QWEN_TOKEN_URL,
    { grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: QWEN_CLIENT_ID },
    { fetch: ctx.fetch, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
  );
  ensureOk(res, "Qwen token refresh");
  const access = typeof res.data.access_token === "string" ? res.data.access_token : "";
  if (access.length === 0) throw new Error("Qwen refresh returned no access_token");
  const expiresIn = typeof res.data.expires_in === "number" ? res.data.expires_in : 6 * 3600;
  return {
    access,
    refresh: typeof res.data.refresh_token === "string" ? res.data.refresh_token : tokens.refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    ...(typeof res.data.resource_url === "string" ? { baseUrl: res.data.resource_url } : {}),
  };
}

export const qwenSpec: OAuthFlowSpec = {
  id: "qwen-oauth",
  name: "Qwen (OAuth)",
  method: "import",
  hint: `Imports ${qwenCredsPath()}`,
  accountId: "qwen",
  run: login,
  refresh,
  import: async () => importQwen(),
};
