import type { AuthStore } from "../auth-store";
import type { OAuthTokens } from "./types";
import { oauthSpec } from "./specs";

/** Refresh-before-expiry skew (ms) per provider. */
const SKEW_MS: Record<string, number> = {
  "openai-codex": 120_000,
  xai: 120_000,
  anthropic: 120_000,
  "minimax-oauth": 60_000,
  nous: 120_000,
  "qwen-oauth": 120_000,
  copilot: 120_000,
  vertex: 300_000,
};

export function oauthSkewMs(providerId: string): number {
  return SKEW_MS[providerId] ?? 120_000;
}

/** True when an OAuth account should be renewed before use. */
export function needsRefresh(providerId: string, expiresAt: number | undefined, now = Date.now()): boolean {
  if (expiresAt === undefined) return false;
  return expiresAt <= now + oauthSkewMs(providerId);
}

const inflight = new Map<string, Promise<OAuthTokens>>();

export interface RenewDeps {
  accounts: AuthStore;
  fetch?: typeof globalThis.fetch;
}

/**
 * Renew an OAuth account's access token and persist the rotated pair.
 * Single-flight per account: concurrent resolves share one refresh call (some
 * providers rotate single-use refresh tokens, so a stampede would invalidate
 * the grant). A persistence failure propagates — callers fail closed.
 */
export async function renewOAuthTokens(
  providerId: string,
  accountId: string,
  current: { access: string; refresh?: string; idToken?: string },
  deps: RenewDeps,
): Promise<OAuthTokens> {
  const key = `${providerId}/${accountId}`;
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;

  const spec = oauthSpec(providerId);
  if (spec?.refresh === undefined) {
    throw new Error(`provider "${providerId}" cannot refresh OAuth tokens; reconnect required`);
  }
  const promise = spec
    .refresh(current, { fetch: deps.fetch ?? globalThis.fetch.bind(globalThis), now: Date.now })
    .then((tokens) => {
      deps.accounts.updateOAuthTokens(providerId, accountId, {
        access: tokens.access,
        ...(tokens.refresh !== undefined ? { refresh: tokens.refresh } : {}),
        ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
        ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
        ...(tokens.baseUrl !== undefined ? { baseUrl: tokens.baseUrl } : {}),
      });
      return tokens;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}
