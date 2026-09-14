import { z } from "zod";
import type { ModelInfo } from "./domain";

/**
 * Provider/account wire types — shared by core (truth), api (boundary), and
 * every surface. Raw API keys and OAuth tokens NEVER appear here: accounts
 * are projected with `hasKey`/`oauth` booleans only; secrets live in the core
 * AuthStore and auth.json.
 */

/** Adapter implementations bai ships. `openai-compatible` is the catch-all. */
export type AdapterName = "openai" | "anthropic" | "openai-compatible" | "responses";

/** Where an account's credential comes from. */
export type AccountSource = "api" | "env" | "oauth";

/**
 * Public projection of one provider account (one API key / OAuth identity).
 * `id: "env"` is the pseudo-account backed by the provider's env var.
 */
export interface AccountInfo {
  provider: string;
  id: string;
  label: string;
  source: AccountSource;
  /** Per-account endpoint override (e.g. a proxy or self-hosted gateway). */
  baseUrl?: string;
  /** True when a concrete API key is present (never the key itself). */
  hasKey: boolean;
  /** True when this account authenticates via OAuth (tokens are never exposed). */
  oauth?: boolean;
  /** OAuth token expiry (epoch ms) when known. */
  expiresAt?: number;
  /** OAuth upstream identity (account id / email / subject) when known. */
  accountId?: string;
}

/** Where a provider definition comes from. */
export type ProviderSource = "catalog" | "config" | "builtin";

/** Public projection of one provider: catalog metadata ⊕ accounts. */
export interface ProviderInfo {
  id: string;
  name: string;
  adapter: AdapterName;
  source: ProviderSource;
  /** Resolved default endpoint (no secrets). */
  baseUrl?: string;
  models: ModelInfo[];
  accounts: AccountInfo[];
  /** Convenience: `accounts.length > 0`. */
  connected: boolean;
  /** True for a user config-defined custom provider (not catalog/curated). */
  custom?: boolean;
  /** Number of configured extra request headers (custom providers; names never exposed). */
  headerCount?: number;
  /** Configured context window override (custom providers). */
  contextLength?: number;
  /**
   * Authentication shape: `"api_key"` (default) or an OAuth method
   * (`"device_code" | "paste_code" | "import" | "adc"`).
   */
  authType?: OAuthMethod | "api_key";
  /**
   * Catalog size when `models` is intentionally omitted (`GET /provider?models=0`
   * — UI fetches that only need connection/account state). Undefined when the
   * full model array is present.
   */
  modelCount?: number;
}

/** GET /api/provider response. */
export interface ProviderListResponse {
  providers: ProviderInfo[];
  default: { model?: string; account?: string };
}

// --- OAuth logins ---------------------------------------------------------

/** How an OAuth login is driven. */
export type OAuthMethod = "redirect" | "device_code" | "paste_code" | "import" | "adc";

/**
 * Login execution preference chosen by the surface:
 *  - `redirect` — loopback callback + browser (local clients only);
 *  - `device`   — device-code / paste-code fallback (works remotely);
 *  - `auto`     — prefer redirect when the provider supports it.
 */
export type OAuthStartMode = "redirect" | "device" | "auto";

/** Lifecycle of one server-side OAuth login attempt. */
export type OAuthLoginStatus =
  | "pending"
  | "awaiting_code"
  | "approved"
  | "error"
  | "cancelled"
  | "expired";

/**
 * Public projection of one in-flight OAuth login session. Secrets (tokens,
 * PKCE verifiers, device codes) never cross the wire; device-code flows do
 * expose the one-time `userCode` the user must type.
 */
export interface OAuthLoginSession {
  id: string;
  provider: string;
  method: OAuthMethod;
  status: OAuthLoginStatus;
  /** Device-code flows: the one-time code the user enters. */
  userCode?: string;
  /** Device-code flows: verification page. */
  verificationUri?: string;
  /** Device-code flows: verification page with the code pre-filled. */
  verificationUriComplete?: string;
  /** Paste-code flows: authorize URL the user opens. */
  authorizeUrl?: string;
  /** Human-readable instructions (import paths, ADC notes). */
  instructions?: string;
  /** Account id written on approval. */
  accountId?: string;
  error?: string;
  createdAt: string;
  /** Session expiry (epoch ms). */
  expiresAt?: number;
}

/** One provider that supports an OAuth/import login. */
export interface OAuthProviderInfo {
  id: string;
  name: string;
  method: OAuthMethod;
  /** True when at least one OAuth account already exists for the provider. */
  connected: boolean;
  /** Account id the connect flow writes when the user does not name one. */
  defaultAccount?: string;
  /** UI hint (e.g. "imports ~/.qwen/oauth_creds.json"). */
  hint?: string;
}

/**
 * Suggest an unused account id for "add another account" flows. `base` is
 * tried first (normalized), then `base2`, `base3`, … Returns the first id not
 * present in `existing` (case-insensitive).
 */
export function suggestAccountId(existing: Iterable<string>, base = "account"): string {
  const taken = new Set([...existing].map((id) => id.trim().toLowerCase()));
  const root = base.trim().length > 0 ? base.trim() : "account";
  if (!taken.has(root.toLowerCase())) return root;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${root}-${Date.now()}`;
}

/** PUT /api/provider/:provider/account/:account body. */
export const putAccountSchema = z
  .object({
    label: z.string().min(1).max(100).optional(),
    key: z.string().min(1).max(4096).optional(),
    baseUrl: z.string().url().optional(),
  })
  .refine((v) => v.label !== undefined || v.key !== undefined || v.baseUrl !== undefined, {
    message: "at least one of label, key, baseUrl is required",
  });

/** POST /api/provider/:provider/oauth/start body. */
export const oauthStartSchema = z.object({
  /** Preferred account id to write on approval (defaults to "oauth"). */
  account: z.string().min(1).max(100).optional(),
  /** Login execution preference (default "auto"). */
  mode: z.enum(["redirect", "device", "auto"]).optional(),
});

/** POST /api/provider/:provider/oauth/submit body (paste-code flows). */
export const oauthSubmitSchema = z.object({
  code: z.string().min(1).max(8192),
});

/**
 * PUT /api/provider/:provider/custom body — a config-defined custom provider.
 * `apiKey` is write-only and persisted into the layered config; when both are
 * present `apiKeyEnv` is preferred at runtime.
 */
export const customProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  baseUrl: z.string().url().optional(),
  adapter: z.enum(["openai", "anthropic", "openai-compatible", "responses"]).optional(),
  apiKeyEnv: z.string().min(1).max(200).optional(),
  apiKey: z.string().min(1).max(4096).optional(),
  models: z.array(z.string().min(1).max(200)).max(1000).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  contextLength: z.number().int().positive().max(10_000_000).optional(),
  tls: z
    .object({
      caCert: z.string().max(4096).optional(),
      verify: z.boolean().optional(),
    })
    .optional(),
  authType: z.enum(["api_key", "redirect", "device_code", "paste_code", "import", "adc"]).optional(),
});

/** PUT /api/session/:id/model body. Omitting `account` keeps the current one. */
export const setSessionModelSchema = z.object({
  model: z.string().min(1).max(200),
  account: z.string().min(1).max(100).optional(),
});

/** PUT /api/session/:id/agent body — select or clear the session's agent. */
export const setSessionAgentSchema = z
  .object({
    agent: z.string().min(1).max(100).optional(),
    clear: z.boolean().optional(),
  })
  .refine((v) => v.clear === true || (v.agent !== undefined && v.agent.length > 0), {
    message: "agent is required unless clear is true",
  });

export type PutAccountBody = z.infer<typeof putAccountSchema>;
export type OAuthStartBody = z.infer<typeof oauthStartSchema>;
export type OAuthSubmitBody = z.infer<typeof oauthSubmitSchema>;
export type CustomProviderBody = z.infer<typeof customProviderSchema>;
export type SetSessionModelBody = z.infer<typeof setSessionModelSchema>;
export type SetSessionAgentBody = z.infer<typeof setSessionAgentSchema>;
