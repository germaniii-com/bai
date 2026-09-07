import type { AccountInfo, AdapterName, ModelInfo, ProviderInfo, ProviderListResponse } from "@bai/shared";
import type { Config } from "@bai/shared";
import type { CatalogProvider, CatalogService } from "./catalog";
import { WELL_KNOWN_BASE_URLS } from "./catalog";
import type { AuthStore, SetAccountInput } from "./auth-store";
import type { LlmRequest, Provider, ProviderStream } from "./types";
import type { UsageRates } from "../store/usage";
import { ZERO_RATES } from "../store/usage";
import { EchoProvider } from "./stub";
import { pickSmallModel } from "../title";

export interface RegistryDeps {
  catalog: CatalogService;
  config(): Config;
  accounts: AuthStore;
  /** Env override for tests (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export interface ResolvedModel {
  provider: Provider;
  providerId: string;
  model: string;
  /** Model emits reasoning tokens — the run enables thinking for it. */
  reasoning: boolean;
  /** Catalog context window (tokens) when known — compaction triggers key on it. */
  contextWindow?: number;
}

export interface ResolvedCredentials {
  accountId?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Where the key came from — surfaced in errors/logs, never the key itself. */
  source: "account" | "env" | "config" | "keyless";
}

/**
 * Dynamic provider registry — the "no restart" guarantee. Providers are NOT
 * registered at boot; they are derived per lookup from the catalog
 * (models.dev ⊕ config) and materialized lazily. Adapters are stateless
 * (credentials ride each request), so the per-provider cache never goes stale
 * on key changes — only `invalidate()` (config edits) clears it.
 *
 * `register()` remains for builtins/tests; registered providers win over
 * catalog-derived ones.
 */
export class ProviderRegistry {
  private registered = new Map<string, Provider>();
  private materialized = new Map<string, Provider>();

  constructor(private deps: RegistryDeps) {
    // The keyless echo stub is always available — bai works with zero
    // credentials, and it keeps tests/headless runs honest without network.
    this.register(new EchoProvider());
  }

  /** Config changed → adapter set/baseUrl defaults may have changed. */
  invalidate(): void {
    this.materialized.clear();
  }

  /** Builtins/tests win over catalog-derived adapters. */
  register(provider: Provider): void {
    this.registered.set(provider.name(), provider);
    this.materialized.set(provider.name(), provider);
  }

  /** All known provider ids: registered ⊕ catalog ⊕ config ⊕ builtin stub. */
  async providerIds(): Promise<string[]> {
    const ids = new Set<string>(["stub"]);
    for (const p of this.registered.keys()) ids.add(p);
    for (const p of await this.deps.catalog.providers()) ids.add(p.id);
    return [...ids];
  }

  /** Materialize (and cache) the adapter for a provider id. */
  async adapterFor(providerId: string): Promise<Provider | undefined> {
    const cached = this.materialized.get(providerId);
    if (cached !== undefined) return cached;
    const registered = this.registered.get(providerId);
    if (registered !== undefined) return registered;

    const entry = await this.deps.catalog.get(providerId);
    if (entry === undefined) return undefined;
    const adapter = adapterNameFor(entry);
    if (adapter === undefined) return undefined; // unsupported wire shape

    const provider =
      adapter === "anthropic"
        ? new (await import("./adapters/anthropic")).AnthropicProvider(providerId)
        : new (await import("./adapters/openai")).OpenAiCompatProvider(providerId);
    this.materialized.set(providerId, provider);
    return provider;
  }

  /** Resolve "provider/model" → adapter + vendor model id (+ reasoning flag). */
  async resolveModel(modelId: string): Promise<ResolvedModel> {
    const idx = modelId.indexOf("/");
    const providerId = idx >= 0 ? modelId.slice(0, idx) : modelId;
    const provider = await this.adapterFor(providerId);
    if (provider === undefined) {
      throw new Error(`Unknown or unsupported provider in model id "${modelId}"`);
    }
    const model = idx >= 0 ? modelId.slice(idx + 1) : modelId;
    const entry = await this.deps.catalog.get(providerId);
    const info = entry?.models.find((m) => m.id === model);
    const reasoning = info?.reasoning === true;
    return {
      provider,
      providerId,
      model,
      reasoning,
      ...(info?.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
    };
  }

  /** Stored accounts ⊕ the env pseudo-account when the provider's env var is set. */
  async accounts(providerId: string): Promise<AccountInfo[]> {
    const stored = this.deps.accounts.list(providerId);
    const envName = await this.envVarFor(providerId);
    if (envName !== undefined && (this.env()[envName] ?? "").length > 0) {
      stored.push({ provider: providerId, id: "env", label: `env: ${envName}`, source: "env", hasKey: true });
    }
    return stored;
  }

  /**
   * Credentials for a stream call. Precedence: named account → provider's
   * first stored account → env var → config apiKey/apiKeyEnv → keyless.
   * Per-account baseUrl overrides the provider default.
   */
  async resolveCredentials(providerId: string, accountId?: string): Promise<ResolvedCredentials> {
    // Named account first; a missing name (deleted account) falls back to the
    // provider default rather than failing the run.
    const stored =
      (accountId !== undefined ? this.deps.accounts.resolve(providerId, accountId) : undefined) ??
      this.deps.accounts.resolve(providerId);
    if (stored !== undefined) {
      return {
        ...(stored.accountId !== undefined ? { accountId: stored.accountId } : {}),
        apiKey: stored.apiKey,
        baseUrl: stored.baseUrl ?? (await this.defaultBaseUrl(providerId)),
        source: "account",
      };
    }

    const envName = await this.envVarFor(providerId);
    const envKey = envName !== undefined ? this.env()[envName] : undefined;
    if (envKey !== undefined && envKey.length > 0) {
      return {
        accountId: "env",
        apiKey: envKey,
        ...(await withDefaultBaseUrl(this.deps, providerId)),
        source: "env",
      };
    }

    const pc = this.deps.config().providers[providerId];
    if (pc?.apiKey !== undefined && pc.apiKey.length > 0) {
      return { apiKey: pc.apiKey, ...(await withDefaultBaseUrl(this.deps, providerId)), source: "config" };
    }
    if (pc?.apiKeyEnv !== undefined) {
      const key = this.env()[pc.apiKeyEnv];
      if (key !== undefined && key.length > 0) {
        return { apiKey: key, ...(await withDefaultBaseUrl(this.deps, providerId)), source: "config" };
      }
    }

    return { ...(await withDefaultBaseUrl(this.deps, providerId)), source: "keyless" };
  }

  /** Default account for a provider: config override → first stored → env. */
  async defaultAccount(providerId: string): Promise<string | undefined> {
    const configured = this.deps.config().models.defaultAccount?.[providerId];
    if (configured !== undefined) return configured;
    const stored = this.deps.accounts.list(providerId);
    if (stored.length > 0) return stored[0]?.id;
    const envName = await this.envVarFor(providerId);
    if (envName !== undefined && (this.env()[envName] ?? "").length > 0) return "env";
    return undefined;
  }

  /** Merged provider view for API + pickers. Unsupported shapes are excluded. */
  async listProviders(): Promise<ProviderInfo[]> {
    const [entries, ids] = await Promise.all([this.deps.catalog.providers(), this.providerIds()]);
    const byId = new Map(entries.map((p) => [p.id, p]));
    const out: ProviderInfo[] = [];
    for (const id of ids) {
      const registered = this.registered.get(id);
      if (registered !== undefined) {
        out.push(await this.builtinInfo(registered, byId.get(id)));
        continue;
      }
      const entry = byId.get(id);
      if (entry === undefined) continue;
      const adapter = adapterNameFor(entry);
      if (adapter === undefined) continue; // google/bedrock/… — not usable yet
      out.push({
        id,
        name: entry.name,
        adapter,
        source: entry.source,
        ...(await defaultBaseUrlInfo(this.deps, entry)),
        models: catalogModels(id, entry),
        accounts: await this.accounts(id),
        connected: await this.isConnected(id),
      });
    }

    // Providers with stored accounts or config but no catalog entry (custom
    // credentials saved ahead of configuration — visible, manageable, and
    // streamable once config gives them a baseUrl/models).
    const seen = new Set(out.map((p) => p.id));
    const extra = new Set<string>([
      ...this.deps.accounts.list().map((a) => a.provider),
      ...Object.keys(this.deps.config().providers),
    ]);
    for (const id of [...extra].sort()) {
      if (seen.has(id)) continue;
      const pc = this.deps.config().providers[id];
      out.push({
        id,
        name: pc?.name ?? id,
        adapter: pc?.adapter ?? "openai-compatible",
        source: "config",
        ...(pc?.baseUrl !== undefined ? { baseUrl: pc.baseUrl } : {}),
        models: (pc?.models ?? []).map((m) => ({ id: `${id}/${m}`, provider: id, label: m, supportsTools: false })),
        accounts: await this.accounts(id),
        connected: await this.isConnected(id),
      });
    }

    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async allModels(): Promise<ModelInfo[]> {
    const providers = await this.listProviders();
    return providers.flatMap((p) => p.models);
  }

  /**
   * A small non-thinking model of the given provider for background calls
   * (session titling) — opencode's getSmallModel adapted to bai's catalog.
   * Registered providers win, then the catalog, then config-declared models.
   * Undefined when nothing qualifies (caller falls back to the session's own
   * model).
   */
  async smallModelFor(providerId: string): Promise<string | undefined> {
    const registered = this.registered.get(providerId);
    if (registered !== undefined) return pickSmallModel(await registered.models());
    const entry = await this.deps.catalog.get(providerId);
    if (entry !== undefined) return pickSmallModel(catalogModels(providerId, entry));
    const pc = this.deps.config().providers[providerId];
    const models = (pc?.models ?? []).map((m) => ({
      id: `${providerId}/${m}`,
      provider: providerId,
      label: m,
      supportsTools: false,
    }));
    return pickSmallModel(models);
  }

  /**
   * Effective usage rates (USD per 1M tokens) for a model — the usage
   * recorder's per-row snapshot (D26). The catalog's base input/output price
   * is multiplied by how each vendor bills cache tokens: Anthropic reads
   * 0.1×, 5m writes 1.25×, 1h writes 2×; OpenAI-shaped providers read 0.5×
   * and don't separately price writes. Models without published pricing get
   * zero rates — token counts remain the source of truth, spend shows 0.
   */
  async usageRates(providerId: string, model: string): Promise<UsageRates> {
    const entry = await this.deps.catalog.get(providerId);
    const info = entry?.models.find((m) => m.id === model);
    const input = info?.inputCost;
    const output = info?.outputCost;
    if (input === undefined && output === undefined) return ZERO_RATES;
    const anthropic = entry !== undefined && adapterNameFor(entry) === "anthropic";
    return {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: (input ?? 0) * (anthropic ? 0.1 : 0.5),
      cacheWrite: (input ?? 0) * (anthropic ? 1.25 : 0),
      cacheWrite1h: (input ?? 0) * (anthropic ? 2 : 0),
    };
  }

  /** GET /api/provider payload. */
  async listResponse(): Promise<ProviderListResponse> {
    const config = this.deps.config();
    return {
      providers: await this.listProviders(),
      default: {
        ...(config.models.default !== undefined ? { model: config.models.default } : {}),
        ...(config.models.default !== undefined
          ? { account: await this.defaultAccount(config.models.default.split("/")[0] ?? "") }
          : {}),
      },
    };
  }

  setAccount(providerId: string, accountId: string, input: SetAccountInput): AccountInfo {
    return this.deps.accounts.set(providerId, accountId, input);
  }

  removeAccount(providerId: string, accountId: string): boolean {
    return this.deps.accounts.remove(providerId, accountId);
  }

  private async isConnected(providerId: string): Promise<boolean> {
    return (await this.accounts(providerId)).length > 0;
  }

  private async builtinInfo(registered: Provider, entry: CatalogProvider | undefined): Promise<ProviderInfo> {
    const id = registered.name();
    return {
      id,
      name: entry?.name ?? id,
      adapter: "openai-compatible",
      source: "builtin",
      models: (await registered.models()).length > 0 ? await registered.models() : entry !== undefined ? catalogModels(id, entry) : [],
      accounts: await this.accounts(id),
      connected: await this.isConnected(id),
    };
  }

  private env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }

  /** Env var holding this provider's key: config override → catalog list. */
  private async envVarFor(providerId: string): Promise<string | undefined> {
    const pc = this.deps.config().providers[providerId];
    if (pc?.apiKeyEnv !== undefined) return pc.apiKeyEnv;
    const entry = await this.deps.catalog.get(providerId);
    return entry?.env[0];
  }

  private async defaultBaseUrl(providerId: string): Promise<string | undefined> {
    return baseUrlFor(await this.deps.catalog.get(providerId), providerId, this.deps.config());
  }
}

async function withDefaultBaseUrl(
  deps: RegistryDeps,
  providerId: string,
): Promise<{ baseUrl?: string }> {
  const baseUrl = baseUrlFor(await deps.catalog.get(providerId), providerId, deps.config());
  return baseUrl !== undefined ? { baseUrl } : {};
}

async function defaultBaseUrlInfo(
  deps: RegistryDeps,
  entry: CatalogProvider,
): Promise<{ baseUrl?: string }> {
  const baseUrl = baseUrlFor(entry, entry.id, deps.config());
  return baseUrl !== undefined ? { baseUrl } : {};
}

/** Provider default endpoint: config override → catalog api → well-known map. */
function baseUrlFor(entry: CatalogProvider | undefined, providerId: string, config: Config): string | undefined {
  return config.providers[providerId]?.baseUrl ?? entry?.api ?? WELL_KNOWN_BASE_URLS[providerId];
}

/** Wire-shape detection: anthropic/openai natives, else openai-compatible. */
function adapterNameFor(entry: CatalogProvider): AdapterName | undefined {
  if (entry.npm === "@ai-sdk/anthropic") return "anthropic";
  if (entry.npm === "@ai-sdk/openai") return "openai";
  if (entry.npm === "@ai-sdk/openai-compatible") return "openai-compatible";
  // Vendor-wrapped but openai-wire-compatible (openrouter, groq, xai, …):
  // identifiable by a known endpoint.
  if (entry.api !== undefined || WELL_KNOWN_BASE_URLS[entry.id] !== undefined) {
    return "openai-compatible";
  }
  return undefined; // google / bedrock / azure / vertex shapes — unsupported
}

function catalogModels(providerId: string, entry: CatalogProvider): ModelInfo[] {
  return entry.models.map((m) => ({
    id: `${providerId}/${m.id}`,
    provider: providerId,
    label: m.name,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    supportsTools: m.toolCall,
    ...(m.inputCost !== undefined ? { inputCost: m.inputCost } : {}),
    ...(m.outputCost !== undefined ? { outputCost: m.outputCost } : {}),
    ...(m.reasoning ? { reasoning: true } : {}),
  }));
}

export type { LlmRequest, Provider, ProviderStream };
