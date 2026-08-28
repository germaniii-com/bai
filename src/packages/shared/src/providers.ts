import { z } from "zod";
import type { ModelInfo } from "./domain";

/**
 * Provider/account wire types — shared by core (truth), api (boundary), and
 * every surface. Raw API keys NEVER appear here: accounts are projected with
 * `hasKey` booleans only; keys live in the core AuthStore and auth.json.
 */

/** Adapter implementations bai ships. `openai-compatible` is the catch-all. */
export type AdapterName = "openai" | "anthropic" | "openai-compatible";

/** Where an account's credential comes from. */
export type AccountSource = "api" | "env";

/**
 * Public projection of one provider account (one API key / identity).
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
}

/** GET /api/provider response. */
export interface ProviderListResponse {
  providers: ProviderInfo[];
  default: { model?: string; account?: string };
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

/** PUT /api/session/:id/model body. Omitting `account` keeps the current one. */
export const setSessionModelSchema = z.object({
  model: z.string().min(1).max(200),
  account: z.string().min(1).max(100).optional(),
});

export type PutAccountBody = z.infer<typeof putAccountSchema>;
export type SetSessionModelBody = z.infer<typeof setSessionModelSchema>;
