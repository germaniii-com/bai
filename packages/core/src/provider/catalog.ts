import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AdapterName, Config } from "@bai/shared";
import { CURATED_PROVIDERS } from "./overlay";

/** Freshness window before a background refresh is attempted (opencode: 5 min). */
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Base URLs for popular openai-compatible providers whose models.dev entry
 * omits `api` (their vendor SDKs hardcode it; bai talks the wire protocol
 * directly, so it needs the URL explicitly).
 */
export const WELL_KNOWN_BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  perplexity: "https://api.perplexity.ai",
  cerebras: "https://api.cerebras.ai/v1",
  together: "https://api.together.xyz/v1",
};

/** Normalized provider entry — vendor shapes never leak past this module. */
export interface CatalogModel {
  id: string;
  name: string;
  toolCall: boolean;
  reasoning: boolean;
  contextWindow?: number;
  inputCost?: number;
  outputCost?: number;
  /** models.dev `attachment` — the model accepts file attachments. */
  attachment?: boolean;
  /** models.dev input modalities (e.g. ["text","image","pdf"]). */
  inputModalities?: string[];
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** models.dev SDK hint; drives adapter selection in the registry. */
  npm: string;
  api?: string;
  env: string[];
  models: CatalogModel[];
  /** Where the entry came from: models.dev, config, or the builtin stub. */
  source: "catalog" | "config" | "builtin";
  /** Explicit wire adapter (curated overlay / config override). */
  adapter?: AdapterName;
  /** Primary auth shape (curated overlay; OAuth specs add login methods). */
  authType?: "api_key" | "redirect" | "device_code" | "paste_code" | "import" | "adc";
  /** Default request headers for this provider (custom gateways / quirks). */
  headers?: Record<string, string>;
  /** True when the provider works with no credential (free tier). */
  keyless?: boolean;
  /** Alternate ids that resolve to this provider. */
  aliases?: string[];
}

/** Raw models.dev api.json entry (cache file + client response shape). */
interface ModelsDevProvider {
  id?: string;
  name?: string;
  npm?: string;
  api?: string;
  env?: string[];
  models?: Record<
    string,
    {
      id?: string;
      name?: string;
      tool_call?: boolean;
      reasoning?: boolean;
      attachment?: boolean;
      modalities?: { input?: unknown };
      limit?: { context?: number };
      cost?: { input?: number; output?: number };
    }
  >;
}

/**
 * Dynamic provider catalog: models.dev (memory ⊕ disk cache ⊕ bundled offline
 * snapshot, refreshed from the network in the background) merged with
 * config-defined custom providers.
 *
 * Local-first, never blocks a drain: `providers()` answers instantly from
 * memory/disk/snapshot and refreshes in the background when older than the
 * TTL — so newly published catalog entries appear without a restart, and a
 * dead network never degrades runtime behavior.
 */
export class CatalogService {
  private memory?: { at: number; providers: CatalogProvider[] };
  private refreshing = false;

  constructor(
    private opts: {
      cachePath: string;
      config(): Config;
      ttlMs?: number;
      fetch?: typeof globalThis.fetch;
      /** Test hook: no bundled snapshot AND no network (fully offline). */
      offline?: boolean;
    },
  ) {}

  /** Drop the memory cache; the next call re-derives from disk/snapshot. */
  invalidate(): void {
    this.memory = undefined;
  }

  /** All providers: models.dev base ⊕ curated overlay ⊕ config, sorted by id. Never throws. */
  async providers(): Promise<CatalogProvider[]> {
    const base = await this.baseProviders();
    this.maybeRefreshInBackground();
    return mergeConfigProviders(mergeCurated(base), this.opts.config());
  }

  get(providerId: string): Promise<CatalogProvider | undefined> {
    return this.providers().then((all) => all.find((p) => p.id === providerId));
  }

  /** Local-first base list — instant after the very first success. */
  private async baseProviders(): Promise<CatalogProvider[]> {
    if (this.memory !== undefined) return this.memory.providers;

    const disk = this.readDisk();
    if (disk !== undefined) {
      // Memoize: every providers()/get() call funnels through here and the
      // registry performs hundreds of lookups per request — re-reading and
      // re-parsing the multi-MB cache each time froze the whole app (server
      // and TUI share one event loop). `invalidate()` clears memory, so
      // config-driven re-derivation still sees fresh disk state.
      const providers = normalizeModelsDev(disk.doc);
      this.memory = { at: disk.at, providers };
      return providers;
    }

    if (!this.opts.offline) {
      // Bundled snapshot ships with the binary — local, instant, ≤24 h old.
      const snapshot = await this.readSnapshot();
      if (snapshot !== undefined) {
        // Same memoization as the disk path. `at: 0` marks the data as
        // TTL-expired so exactly one background refresh fires; a successful
        // refresh stamps a fresh `at` and writes the disk cache.
        const providers = normalizeModelsDev(snapshot);
        this.memory = { at: 0, providers };
        return providers;
      }
    }
    // Nothing local at all (fresh install, snapshot excluded): one bounded
    // network attempt; failure leaves an empty base (config providers + stub
    // still work).
    if (this.opts.offline) return [];
    return this.fetchAndCache().catch(() => []);
  }

  /** TTL-gated fire-and-forget refresh; failures keep the current data. */
  private maybeRefreshInBackground(): void {
    if (this.refreshing || this.opts.offline) return;
    const ttl = this.opts.ttlMs ?? DEFAULT_TTL_MS;
    const at = this.memory?.at ?? this.readDisk()?.at ?? 0;
    if (Date.now() - at < ttl) return;
    this.refreshing = true;
    void this.fetchAndCache()
      .catch(() => {})
      .finally(() => {
        this.refreshing = false;
      });
  }

  private async fetchAndCache(): Promise<CatalogProvider[]> {
    const doc = await this.fetchModelsDev();
    this.writeDisk(doc);
    this.memory = { at: Date.now(), providers: normalizeModelsDev(doc) };
    return this.memory.providers;
  }

  private async fetchModelsDev(): Promise<Record<string, ModelsDevProvider>> {
    const { Models } = await import("@opencode-ai/models");
    const client = Models.make({ ...(this.opts.fetch !== undefined ? { fetch: this.opts.fetch } : {}) });
    const doc = await client.providers();
    return doc as unknown as Record<string, ModelsDevProvider>;
  }

  private async readSnapshot(): Promise<Record<string, ModelsDevProvider> | undefined> {
    try {
      const mod = (await import("@opencode-ai/models/snapshot")) as {
        default: { providers: Record<string, ModelsDevProvider> };
      };
      return mod.default.providers;
    } catch {
      return undefined;
    }
  }

  private readDisk(): { at: number; doc: Record<string, ModelsDevProvider> } | undefined {
    if (!existsSync(this.opts.cachePath)) return undefined;
    try {
      const doc = JSON.parse(readFileSync(this.opts.cachePath, "utf8")) as Record<string, ModelsDevProvider>;
      const at = statSync(this.opts.cachePath).mtimeMs;
      return { at, doc };
    } catch {
      try {
        unlinkSync(this.opts.cachePath);
      } catch {
        // best effort — corrupt cache is treated as missing
      }
      return undefined;
    }
  }

  private writeDisk(doc: Record<string, ModelsDevProvider>): void {
    try {
      mkdirSync(path.dirname(this.opts.cachePath), { recursive: true });
      const tmp = `${this.opts.cachePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc));
      renameSync(tmp, this.opts.cachePath);
    } catch {
      // Cache write failures are non-fatal (memory + snapshot still work).
    }
  }
}

/** models.dev api.json → normalized entries (drops malformed rows). */
function normalizeModelsDev(doc: Record<string, ModelsDevProvider>): CatalogProvider[] {
  const out: CatalogProvider[] = [];
  for (const [id, raw] of Object.entries(doc)) {
    if (typeof id !== "string" || id.length === 0) continue;
    const models: CatalogModel[] = [];
    for (const [modelId, m] of Object.entries(raw.models ?? {})) {
      if (typeof modelId !== "string" || modelId.length === 0) continue;
      models.push({
        id: modelId,
        name: m.name ?? modelId,
        toolCall: m.tool_call === true,
        reasoning: m.reasoning === true,
        ...(m.attachment === true ? { attachment: true } : {}),
        ...(Array.isArray(m.modalities?.input)
          ? { inputModalities: m.modalities.input.filter((x): x is string => typeof x === "string") }
          : {}),
        ...(typeof m.limit?.context === "number" ? { contextWindow: m.limit.context } : {}),
        ...(typeof m.cost?.input === "number" ? { inputCost: m.cost.input } : {}),
        ...(typeof m.cost?.output === "number" ? { outputCost: m.cost.output } : {}),
      });
    }
    out.push({
      id,
      name: raw.name ?? id,
      npm: raw.npm ?? "@ai-sdk/openai-compatible",
      ...(typeof raw.api === "string" ? { api: raw.api } : {}),
      env: Array.isArray(raw.env) ? raw.env.filter((e): e is string => typeof e === "string") : [],
      models,
      source: "catalog",
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Curated overlay over the raw catalog: adds providers models.dev omits,
 * corrects endpoints/adapters, and attaches auth/header metadata. An overlay
 * entry's models are additive — catalog models are never removed.
 */
function mergeCurated(catalog: CatalogProvider[]): CatalogProvider[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  for (const entry of Object.values(CURATED_PROVIDERS)) {
    const existing = byId.get(entry.id);
    const models: CatalogModel[] = [...(existing?.models ?? [])];
    for (const id of entry.models ?? []) {
      if (!models.some((m) => m.id === id)) {
        models.push({
          id,
          name: id,
          toolCall: true,
          reasoning: false,
          ...(entry.contextLength !== undefined ? { contextWindow: entry.contextLength } : {}),
        });
      }
    }
    byId.set(entry.id, {
      id: entry.id,
      name: entry.name,
      npm: existing?.npm ?? "@ai-sdk/openai-compatible",
      ...(entry.baseUrl !== undefined
        ? { api: entry.baseUrl }
        : existing?.api !== undefined
          ? { api: existing.api }
          : {}),
      env: entry.env ?? existing?.env ?? [],
      models,
      // Curated entries are bai-owned catalog providers, never user "custom"
      // providers — the UI uses source==="config" to mean a config-defined
      // custom endpoint.
      source: existing?.source ?? "catalog",
      ...(entry.adapter !== undefined
        ? { adapter: entry.adapter }
        : existing?.adapter !== undefined
          ? { adapter: existing.adapter }
          : {}),
      ...(entry.authType !== undefined ? { authType: entry.authType } : existing?.authType !== undefined ? { authType: existing.authType } : {}),
      ...(entry.headers !== undefined ? { headers: entry.headers } : existing?.headers !== undefined ? { headers: existing.headers } : {}),
      ...(entry.keyless === true ? { keyless: true } : existing?.keyless === true ? { keyless: true } : {}),
      ...(entry.aliases !== undefined ? { aliases: entry.aliases } : existing?.aliases !== undefined ? { aliases: existing.aliases } : {}),
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Config-defined providers merged over the catalog: unknown ids become custom
 * providers (adapter defaults to openai-compatible); known ids get name/api
 * overrides and extra models. `baseUrl` from config maps onto `api`.
 */
function mergeConfigProviders(catalog: CatalogProvider[], config: Config): CatalogProvider[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  for (const [id, pc] of Object.entries(config.providers)) {
    const existing = byId.get(id);
    const models: CatalogModel[] = [...(existing?.models ?? [])];
    for (const modelId of pc.models ?? []) {
      if (!models.some((m) => m.id === modelId)) {
        models.push({
          id: modelId,
          name: modelId,
          toolCall: false,
          reasoning: false,
          ...(pc.contextLength !== undefined ? { contextWindow: pc.contextLength } : {}),
        });
      }
    }
    const merged: CatalogProvider = {
      id,
      name: pc.name ?? existing?.name ?? id,
      npm:
        existing?.npm ??
        (pc.adapter === "anthropic"
          ? "@ai-sdk/anthropic"
          : pc.adapter === "openai"
            ? "@ai-sdk/openai"
            : pc.adapter === "responses"
              ? "@ai-sdk/openai-responses"
              : "@ai-sdk/openai-compatible"),
      ...(pc.baseUrl !== undefined ? { api: pc.baseUrl } : existing?.api !== undefined ? { api: existing.api } : {}),
      env: existing?.env ?? (pc.apiKeyEnv !== undefined ? [pc.apiKeyEnv] : []),
      models,
      source: existing !== undefined ? "catalog" : "config",
      ...(pc.adapter !== undefined
        ? { adapter: pc.adapter }
        : existing?.adapter !== undefined
          ? { adapter: existing.adapter }
          : {}),
      ...(pc.authType !== undefined
        ? { authType: pc.authType }
        : existing?.authType !== undefined
          ? { authType: existing.authType }
          : {}),
      ...(pc.headers !== undefined
        ? { headers: pc.headers }
        : existing?.headers !== undefined
          ? { headers: existing.headers }
          : {}),
      ...(existing?.keyless === true ? { keyless: true } : {}),
      ...(existing?.aliases !== undefined ? { aliases: existing.aliases } : {}),
    };
    byId.set(id, merged);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
