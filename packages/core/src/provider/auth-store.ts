import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccountInfo, AccountSource } from "@bai/shared";

/** Fields shared by every on-disk credential record. */
interface StoredAccountBase {
  label: string;
  /** Per-account endpoint override (proxy, self-hosted gateway, custom provider). */
  baseUrl?: string;
  /** Extra request headers (custom gateways). */
  headers?: Record<string, string>;
  /** Context window override for config-only models. */
  contextLength?: number;
}

/** API-key credential. */
interface StoredApiAccount extends StoredAccountBase {
  type: "api";
  key: string;
}

/**
 * OAuth credential. `access` is the bearer token (or API-compatible token);
 * `expiresAt` is epoch ms; `accountId` is the upstream identity (Codex account
 * id, Claude profile, Copilot login, …) — never the local account id.
 */
interface StoredOAuthAccount extends StoredAccountBase {
  type: "oauth";
  access: string;
  refresh?: string;
  expiresAt?: number;
  accountId?: string;
  /** Provider-issued id_token (xAI/Nous) when present. */
  idToken?: string;
}

type StoredAccount = StoredApiAccount | StoredOAuthAccount;

/** auth.json shape: keyed `"<providerId>/<accountId>"`. */
type AuthFile = Record<string, StoredAccount>;

export interface SetAccountInput {
  label?: string;
  key?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  contextLength?: number;
}

export interface SetOAuthInput {
  label?: string;
  access: string;
  refresh?: string;
  expiresAt?: number;
  accountId?: string;
  idToken?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  contextLength?: number;
}

export interface OAuthTokenUpdate {
  access: string;
  refresh?: string;
  expiresAt?: number;
  idToken?: string;
  /** Rotated endpoint (Copilot/Vertex compute one per exchange). */
  baseUrl?: string;
}

export interface ResolvedAccount {
  accountId: string;
  /** API key or OAuth access token — the secret adapters send. */
  apiKey?: string;
  baseUrl?: string;
  /** True for OAuth accounts; adapters may branch on this (Anthropic headers). */
  oauth?: boolean;
  refreshToken?: string;
  /** Token expiry, epoch ms. */
  expiresAt?: number;
  /** Upstream OAuth identity. */
  oauthAccountId?: string;
  headers?: Record<string, string>;
  contextLength?: number;
}

/**
 * Multi-account credential store — the piece opencode doesn't have. One file
 * (`auth.json`, 0600, atomic writes) holds N accounts per provider, keyed
 * `"<providerId>/<accountId>"`. A write-through in-memory map keeps reads
 * allocation-free at stream time, so a newly added account is usable on the
 * very next message (no restart).
 *
 * Two record kinds share the file: `api` (API keys) and `oauth` (access /
 * refresh / expiry). Projections (`list`) never include raw secrets — surfaces
 * see `hasKey` / `oauth` / `expiresAt`.
 */
export class AuthStore {
  private readonly file: string;
  private entries = new Map<string, StoredAccount>();

  constructor(opts: { file: string }) {
    this.file = opts.file;
    this.load();
  }

  private load(): void {
    this.entries.clear();
    if (!existsSync(this.file)) return;
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as AuthFile;
      for (const [key, value] of Object.entries(doc)) {
        if (!isStoredAccount(value)) continue;
        this.entries.set(normalizeKey(key), value);
      }
    } catch {
      // Corrupt file: start empty rather than crash; next write replaces it.
      this.entries.clear();
    }
  }

  private persist(): void {
    const doc: AuthFile = {};
    for (const [key, value] of this.entries) doc[key] = value;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** All accounts, optionally scoped to one provider. Secrets are never returned. */
  list(providerId?: string): AccountInfo[] {
    const out: AccountInfo[] = [];
    for (const [key, value] of this.entries) {
      const slash = key.indexOf("/");
      if (slash <= 0) continue;
      const provider = key.slice(0, slash);
      if (providerId !== undefined && provider !== providerId) continue;
      const source: AccountSource = value.type === "oauth" ? "oauth" : "api";
      out.push({
        provider,
        id: key.slice(slash + 1),
        label: value.label,
        source,
        ...(value.baseUrl !== undefined ? { baseUrl: value.baseUrl } : {}),
        hasKey: value.type === "api" ? value.key.length > 0 : false,
        ...(value.type === "oauth"
          ? {
              oauth: true,
              ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
              ...(value.accountId !== undefined ? { accountId: value.accountId } : {}),
            }
          : {}),
      });
    }
    out.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    return out;
  }

  get(providerId: string, accountId: string): AccountInfo | undefined {
    return this.list(providerId).find((a) => a.id === accountId);
  }

  has(providerId: string, accountId?: string): boolean {
    if (accountId === undefined) return this.list(providerId).length > 0;
    return this.entries.has(`${providerId}/${accountId}`);
  }

  /** True when the provider has at least one OAuth account. */
  hasOAuth(providerId: string): boolean {
    for (const [key, value] of this.entries) {
      const slash = key.indexOf("/");
      if (slash > 0 && key.slice(0, slash) === providerId && value.type === "oauth") return true;
    }
    return false;
  }

  /** Upsert one API account. Returns the public projection. */
  set(providerId: string, accountId: string, input: SetAccountInput): AccountInfo {
    const key = `${providerId}/${normalizeKey(accountId)}`;
    const existing = this.entries.get(key);
    const prior = existing !== undefined && existing.type === "api" ? existing : undefined;
    const next: StoredApiAccount = {
      type: "api",
      label: input.label ?? prior?.label ?? existing?.label ?? accountId,
      key: input.key ?? prior?.key ?? "",
      ...(input.baseUrl !== undefined
        ? { baseUrl: input.baseUrl }
        : existing?.baseUrl !== undefined
          ? { baseUrl: existing.baseUrl }
          : {}),
      ...resolveExtras(input, existing),
    };
    if (next.key.length === 0) throw new Error(`account "${accountId}" has no API key`);
    this.entries.set(key, next);
    this.persist();
    return projection(providerId, next, normalizeKey(accountId));
  }

  /** Upsert one OAuth account (login completion / import). */
  setOAuth(providerId: string, accountId: string, input: SetOAuthInput): AccountInfo {
    if (input.access.length === 0) throw new Error(`account "${accountId}" has no access token`);
    const key = `${providerId}/${normalizeKey(accountId)}`;
    const existing = this.entries.get(key);
    const next: StoredOAuthAccount = {
      type: "oauth",
      label: input.label ?? existing?.label ?? accountId,
      access: input.access,
      ...(input.refresh !== undefined
        ? { refresh: input.refresh }
        : existing?.type === "oauth" && existing.refresh !== undefined
          ? { refresh: existing.refresh }
          : {}),
      ...(input.expiresAt !== undefined
        ? { expiresAt: input.expiresAt }
        : existing?.type === "oauth" && existing.expiresAt !== undefined
          ? { expiresAt: existing.expiresAt }
          : {}),
      ...(input.accountId !== undefined
        ? { accountId: input.accountId }
        : existing?.type === "oauth" && existing.accountId !== undefined
          ? { accountId: existing.accountId }
          : {}),
      ...(input.idToken !== undefined
        ? { idToken: input.idToken }
        : existing?.type === "oauth" && existing.idToken !== undefined
          ? { idToken: existing.idToken }
          : {}),
      ...(input.baseUrl !== undefined
        ? { baseUrl: input.baseUrl }
        : existing?.baseUrl !== undefined
          ? { baseUrl: existing.baseUrl }
          : {}),
      ...resolveExtras(input, existing),
    };
    this.entries.set(key, next);
    this.persist();
    return projection(providerId, next, normalizeKey(accountId));
  }

  /**
   * Update the token material of an existing OAuth account, preserving label,
   * baseUrl, headers and contextLength. Callers that rotate single-use refresh
   * tokens must treat a throw here as a failed refresh (fail closed).
   */
  updateOAuthTokens(providerId: string, accountId: string, tokens: OAuthTokenUpdate): AccountInfo {
    const key = `${providerId}/${normalizeKey(accountId)}`;
    const existing = this.entries.get(key);
    if (existing === undefined || existing.type !== "oauth") {
      throw new Error(`account "${accountId}" is not an OAuth account`);
    }
    const next: StoredOAuthAccount = {
      ...existing,
      access: tokens.access,
      ...(tokens.refresh !== undefined ? { refresh: tokens.refresh } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
      ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
      ...(tokens.baseUrl !== undefined ? { baseUrl: tokens.baseUrl } : {}),
    };
    this.entries.set(key, next);
    this.persist();
    return projection(providerId, next, normalizeKey(accountId));
  }

  remove(providerId: string, accountId: string): boolean {
    const key = `${providerId}/${accountId}`;
    if (!this.entries.delete(key)) return false;
    this.persist();
    return true;
  }

  /**
   * Concrete credentials for a stream call. Precedence: named account →
   * provider's first stored account → undefined (caller may fall back to env
   * or keyless). Per-account baseUrl wins over the provider default.
   */
  resolve(providerId: string, accountId?: string): ResolvedAccount | undefined {
    const key = accountId !== undefined ? `${providerId}/${accountId}` : undefined;
    if (key !== undefined) {
      const hit = this.entries.get(key);
      if (hit === undefined) return undefined;
      return resolveRecord(accountId as string, hit);
    }
    const first = this.list(providerId)[0];
    if (first === undefined) return undefined;
    const stored = this.entries.get(`${providerId}/${first.id}`);
    if (stored === undefined) return undefined;
    return resolveRecord(first.id, stored);
  }
}

function resolveRecord(accountId: string, value: StoredAccount): ResolvedAccount {
  const common = {
    accountId,
    ...(value.baseUrl !== undefined ? { baseUrl: value.baseUrl } : {}),
    ...(value.headers !== undefined ? { headers: value.headers } : {}),
    ...(value.contextLength !== undefined ? { contextLength: value.contextLength } : {}),
  };
  if (value.type === "oauth") {
    return {
      ...common,
      oauth: true,
      apiKey: value.access,
      ...(value.refresh !== undefined ? { refreshToken: value.refresh } : {}),
      ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
      ...(value.accountId !== undefined ? { oauthAccountId: value.accountId } : {}),
    };
  }
  return { ...common, apiKey: value.key };
}

function projection(provider: string, value: StoredAccount, id: string): AccountInfo {
  if (value.type === "oauth") {
    return {
      provider,
      id,
      label: value.label,
      source: "oauth",
      ...(value.baseUrl !== undefined ? { baseUrl: value.baseUrl } : {}),
      hasKey: false,
      oauth: true,
      ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
      ...(value.accountId !== undefined ? { accountId: value.accountId } : {}),
    };
  }
  return {
    provider,
    id,
    label: value.label,
    source: "api" as AccountSource,
    ...(value.baseUrl !== undefined ? { baseUrl: value.baseUrl } : {}),
    hasKey: true,
  };
}

function resolveExtras(
  input: { headers?: Record<string, string>; contextLength?: number },
  existing: StoredAccount | undefined,
): { headers?: Record<string, string>; contextLength?: number } {
  const headers = input.headers ?? existing?.headers;
  const contextLength = input.contextLength ?? existing?.contextLength;
  return {
    ...(headers !== undefined ? { headers } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
  };
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.label !== "string") return false;
  if (v.type === "api") return typeof v.key === "string" && v.key.length > 0;
  if (v.type === "oauth") return typeof v.access === "string" && v.access.length > 0;
  return false;
}

/** Account ids are user-facing slugs; keep them filesystem/URL safe. */
function normalizeKey(id: string): string {
  return id.trim().toLowerCase();
}
