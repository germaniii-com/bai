import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccountInfo, AccountSource } from "@bai/shared";

/** On-disk credential record. Only `type: "api"` exists today (opencode's
 * auth.json union minus oauth/wellknown, which bai defers). */
interface StoredAccount {
  type: "api";
  label: string;
  key: string;
  baseUrl?: string;
}

/** auth.json shape: keyed `"<providerId>/<accountId>"`. */
type AuthFile = Record<string, StoredAccount>;

export interface SetAccountInput {
  label?: string;
  key?: string;
  baseUrl?: string;
}

export interface ResolvedAccount {
  accountId: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Multi-account credential store — the piece opencode doesn't have. One file
 * (`auth.json`, 0600, atomic writes) holds N accounts per provider, keyed
 * `"<providerId>/<accountId>"`. A write-through in-memory map keeps reads
 * allocation-free at stream time, so a newly added account is usable on the
 * very next message (no restart).
 *
 * Projections (`list`) never include raw keys — surfaces see `hasKey`.
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
        if (value?.type === "api" && typeof value.key === "string" && value.key.length > 0) {
          this.entries.set(normalizeKey(key), value);
        }
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

  /** All accounts, optionally scoped to one provider. Keys are never returned. */
  list(providerId?: string): AccountInfo[] {
    const out: AccountInfo[] = [];
    for (const [key, value] of this.entries) {
      const slash = key.indexOf("/");
      if (slash <= 0) continue;
      const provider = key.slice(0, slash);
      if (providerId !== undefined && provider !== providerId) continue;
      out.push({
        provider,
        id: key.slice(slash + 1),
        label: value.label,
        source: "api",
        ...(value.baseUrl !== undefined ? { baseUrl: value.baseUrl } : {}),
        hasKey: true,
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

  /** Upsert one account. Returns the public projection. */
  set(providerId: string, accountId: string, input: SetAccountInput): AccountInfo {
    const key = `${providerId}/${normalizeKey(accountId)}`;
    const existing = this.entries.get(key);
    const next: StoredAccount = {
      type: "api",
      label: input.label ?? existing?.label ?? accountId,
      key: input.key ?? existing?.key ?? "",
      ...(input.baseUrl !== undefined
        ? { baseUrl: input.baseUrl }
        : existing?.baseUrl !== undefined
          ? { baseUrl: existing.baseUrl }
          : {}),
    };
    if (next.key.length === 0) throw new Error(`account "${accountId}" has no API key`);
    this.entries.set(key, next);
    this.persist();
    return { provider: providerId, id: normalizeKey(accountId), label: next.label, source: "api" as AccountSource, ...(next.baseUrl !== undefined ? { baseUrl: next.baseUrl } : {}), hasKey: true };
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
    if (accountId !== undefined) {
      const hit = this.entries.get(`${providerId}/${accountId}`);
      if (hit === undefined) return undefined;
      return { accountId, apiKey: hit.key, ...(hit.baseUrl !== undefined ? { baseUrl: hit.baseUrl } : {}) };
    }
    const first = this.list(providerId)[0];
    if (first === undefined) return undefined;
    const stored = this.entries.get(`${providerId}/${first.id}`);
    if (stored === undefined) return undefined;
    return { accountId: first.id, apiKey: stored.key, ...(stored.baseUrl !== undefined ? { baseUrl: stored.baseUrl } : {}) };
  }
}

/** Account ids are user-facing slugs; keep them filesystem/URL safe. */
function normalizeKey(id: string): string {
  return id.trim().toLowerCase();
}
