import { z } from "zod";
import type { PermissionAction } from "./enums";
import type { AdapterName } from "./providers";
import type { MediaParamValue } from "./media";

export interface ProviderConfig {
  /** Custom base URL — makes any provider OpenAI-compatible (OpenRouter, Ollama…). */
  baseUrl?: string;
  /** Env var holding the API key (preferred over embedding keys in files). */
  apiKeyEnv?: string;
  apiKey?: string;
  /** Wire protocol for this provider (default inferred from the catalog). */
  adapter?: AdapterName;
  /** Display name override. */
  name?: string;
  /** Model ids for config-defined providers absent from the catalog. */
  models?: string[];
  /** Extra request headers (custom gateways: CF Access, routing, etc.). */
  headers?: Record<string, string>;
  /** Context window for config-only models (compaction trigger). */
  contextLength?: number;
  /** TLS overrides for custom/self-hosted endpoints. */
  tls?: { caCert?: string; verify?: boolean };
  /**
   * Authentication shape. `api_key` (default) uses apiKey/apiKeyEnv; the OAuth
   * methods are driven by the server-side login manager. OAuth providers
   * normally inherit this from bai's curated overlay.
   */
  authType?: "api_key" | "redirect" | "device_code" | "paste_code" | "import" | "adc";
}

export interface ModelsConfig {
  default?: string;
  /**
   * Model for background calls (session title generation). Unset → a small
   * non-reasoning model of the session's provider → the session's own model.
   */
  title?: string;
  /** Per-provider default account id, e.g. { "openai": "personal" }. */
  defaultAccount?: Record<string, string>;
  /**
   * Prefer ZDR-capable models: when true, model pickers sort zero-data-retention
   * capable models first (with a badge). Capability comes from bai's curated
   * overlay (shared/src/zdr.ts) — models.dev publishes no retention fields, and
   * actual ZDR activation is an org-level agreement with the provider.
   */
  preferZdr?: boolean;
  /**
   * Ceiling on output tokens for one model turn (prose + tool-call arguments).
   * Unset → the model's catalog output limit → 16k. Raise it when writing large
   * files in one call; lower it to force the model into smaller chunked writes.
   * Resolved by `provider/output-limit.ts` and sent as `params.max_tokens`,
   * which the adapters fall back from at 4096 — a value too small to emit a
   * large `fs.write` argument, which truncates the call mid-JSON.
   */
  maxOutputTokens?: number;
}

/** User identity — the human bai is working for. */
export interface UserConfig {
  /** Display name; injected into the <env> system block so agents know it. */
  name?: string;
}

/**
 * One media-generation modality's defaults (image or video). The provider is
 * a provider id (bai's provider list), the account an account id within it
 * (auth store), the model a vendor model id. Consumed by the modality's
 * workbench executor as the fallback when a job doesn't name one.
 */
export interface MediaGenConfig {
  /** Provider id, e.g. "openai" or "fal". */
  provider?: string;
  /** Account id within that provider (auth store); unset → provider default. */
  account?: string;
  /** Default model id, e.g. "gpt-image-2" or "fal-ai/flux-2". */
  model?: string;
  /**
   * Default generation parameters (aspect ratio, resolution, quality, count,
   * seed, …) — merged under any explicit request/job params. Keys match the
   * selected model's `MediaParamSpec` vocabulary.
   */
  params?: Record<string, MediaParamValue>;
  /** Default tags applied to every generation when the request names none. */
  tags?: string[];
}

/**
 * Job-runtime limits for the in-process media queue (image/video generation).
 * A hung provider call must never block later jobs, and transient upstream
 * failures should be retried before a job is failed.
 */
export interface JobsConfig {
  /** Per-job wall-clock timeout in milliseconds (default 180 000). */
  timeoutMs?: number;
  /**
   * Per-job timeout for video generations (default 900 000). Video renders run
   * minutes at async providers, so they get a longer budget than images.
   */
  videoTimeoutMs?: number;
  /** Maximum attempts for retryable failures — 1 disables retry (default 3). */
  maxAttempts?: number;
  /** Base backoff between attempts in milliseconds (default 1500). */
  backoffMs?: number;
  /** How many media jobs may run at once (default 3). */
  concurrency?: number;
}

export interface AgentsConfig {
  /**
   * Default agent for sessions that select none (new sessions, surfaces that
   * never picked one). Resolution order at drain: session meta → this → the
   * built-in `build` agent. Unknown names fall back to `build` with a warning.
   */
  default?: string;
  /**
   * Maximum subagent nesting depth (the `task` tool). Default 1 — subagents
   * cannot spawn their own subagents. 0 disables spawning entirely.
   */
  subagentDepth?: number;
}

/** How an MCP server is reached. Inferred from `command` vs `url` when absent. */
export type McpTransport = "stdio" | "http" | "sse";

/** One external MCP server definition (config.json `mcp.<name>` or a `mcp/<name>.json` file). */
export interface MCPServerConfig {
  /** Optional discriminator; inferred from `command` (stdio) vs `url` (http). */
  transport?: McpTransport;
  // --- stdio ---
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // --- http ---
  url?: string;
  headers?: Record<string, string>;
  /** Enable the interactive OAuth flow (remote servers). */
  oauth?: boolean | { clientId?: string; clientSecret?: string; scope?: string; clientName?: string };
  // --- shared ---
  /** Disabled servers are listed but never connected (default true). */
  enabled?: boolean;
  /** Connect/request timeout in milliseconds. */
  timeout?: number;
  /** Optional tool whitelist/blacklist for this server. */
  tools?: { include?: string[]; exclude?: string[] };
}

/** A `~/.config/bai/mcp/<name>.json` file: one server, or a multi-server import wrapper. */
export type MCPServerFile = MCPServerConfig | { mcpServers: Record<string, MCPServerConfig> };

/** Where a resolved MCP server definition came from. */
export type McpServerSource = "file" | "config";

/** Live connection state for one MCP server (settings UI + tool gating). */
export type McpServerState = "connected" | "connecting" | "failed" | "disabled" | "needs_auth";

export interface McpServerInfo {
  name: string;
  source: McpServerSource;
  state: McpServerState;
  transport: McpTransport;
  /** Connected tool count (0 until the handshake completes). */
  tools: number;
  /** Present when state is "failed" or "needs_auth". */
  error?: string;
  /** Absolute path of the defining file (file-sourced servers only). */
  path?: string;
}

/** A curated MCP catalog entry (Integrations pane, one-click install). */
export interface McpCatalogEntry {
  name: string;
  title: string;
  description: string;
  /** Grouping label for the catalog UI (e.g. "Developer tools"). */
  category: string;
  /** Server definition to write on install. */
  server: MCPServerConfig;
  /** Env vars the user may need (shown as hints; values live in the shell env). */
  envVars?: { name: string; prompt: string; url?: string; secret?: boolean }[];
  /** True when install should start the OAuth flow after writing the file. */
  oauth?: boolean;
}

/** Valid MCP server names: filename stems — letter first, then letters/digits/-/_. */
export function isValidMcpServerName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
}

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Substitute `${VAR}` references from `env` (leaving unknown refs untouched). */
export function interpolateEnv<T>(value: T, env: Record<string, string | undefined>): T {
  if (typeof value === "string") {
    return value.replace(ENV_REF_RE, (match, name: string) => env[name] ?? match) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env);
    return out as T;
  }
  return value;
}

export interface ServerConfig {
  port?: number;
  token?: string;
}

/**
 * Router gateway settings. `enabled` defaults to ON (unset = enabled), so
 * `bai --web`/`--host` serve the OpenAI-compatible `/v1/*` gateway and
 * `/api/help` by default; Settings → Model Providers → "Run as router"
 * turns it off. The explicit `--router` flag always forces it on.
 */
export interface RouterConfig {
  enabled?: boolean;
}

export type WebSearchProviderId = "auto" | "exa" | "parallel" | "ddgs";

export interface ToolsConfig {
  /**
   * Web search provider selection. `auto` (default) walks Exa → Parallel →
   * ddgs; Exa/Parallel work keyless (public free tier) or keyed via
   * `EXA_API_KEY` / `PARALLEL_API_KEY`. Pinning a provider puts it first.
   */
  webSearch?: {
    provider?: WebSearchProviderId;
    /**
     * Allow keyless public free tiers (default true). When false, only keyed
     * providers are used (unless one is explicitly pinned).
     */
    keylessFallback?: boolean;
  };
}

/** Read-only web-search provider state for the settings UI. */
export interface WebSearchStatus {
  provider: WebSearchProviderId;
  keylessFallback: boolean;
  keys: { exa: boolean; parallel: boolean };
  available: string[];
}

export interface Config {
  providers: Record<string, ProviderConfig>;
  models: ModelsConfig;
  agents: AgentsConfig;
  user: UserConfig;
  /**
   * UI theme id (shared/src/themes.ts). One theme everywhere — set from any
   * surface, applied live everywhere via config.updated. Unknown ids fall
   * back to the default at apply time, so the value is a plain string here.
   */
  theme?: string;
  /** Image-generation defaults (image workbench executor fallback). */
  imageGen?: MediaGenConfig;
  /** Video-generation defaults (video workbench executor fallback). */
  videoGen?: MediaGenConfig;
  permissions: Record<string, PermissionAction>;
  mcp: Record<string, MCPServerConfig>;
  workbenches: Record<string, Record<string, unknown>>;
  /** Registered workspace folder paths (absolute); the web Workspace view
   * groups cwd-rooted sessions by these. Edited via PUT /api/config. */
  workspaces: string[];
  /**
   * Extra folders attached to a workspace, keyed by the workspace's absolute
   * path (the main working directory). They behave like the workspace root for
   * fs tools, the file tree, uploads, and `#file` mentions — the UI groups them
   * under an "External folders" section and mentions resolve a derived folder
   * alias (`#alias/rel/path`). Edited via PUT /api/config.
   */
  workspaceFolders?: Record<string, string[]>;
  /**
   * Archived workspace folder paths (absolute) — removed from the webui's
   * Active list but restorable from its Archived tab. Their sessions carry
   * meta.archived (hidden from every surface's lists) until restored.
   */
  archivedWorkspaces: string[];
  server: ServerConfig;
  tools: ToolsConfig;
  /** Media job-runtime limits (timeout/retries/backoff). */
  jobs: JobsConfig;
  /** Router gateway (`/v1/*` + `/api/help`) settings. Default on. */
  router: RouterConfig;
}

export const DEFAULT_CONFIG: Config = {
  providers: {},
  models: {},
  agents: {},
  user: {},
  permissions: {},
  mcp: {},
  workbenches: {},
  workspaces: [],
  workspaceFolders: {},
  archivedWorkspaces: [],
  server: {},
  tools: {},
  jobs: {},
  router: {},
};

const providerSchema = z.object({
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  adapter: z.enum(["openai", "anthropic", "openai-compatible", "responses"]).optional(),
  name: z.string().min(1).max(100).optional(),
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

const oauthConfigSchema = z.union([
  z.boolean(),
  z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scope: z.string().optional(),
    clientName: z.string().optional(),
  }),
]);

export const mcpServerSchema = z.object({
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: oauthConfigSchema.optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().positive().max(600_000).optional(),
  tools: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Validates one MCP file (single server or `{ "mcpServers": {...} }` wrapper). */
export const mcpServerFileSchema = z.union([
  z.object({ mcpServers: z.record(z.string(), mcpServerSchema) }),
  mcpServerSchema,
]);

const agentsSchema = z.object({
  default: z.string().max(100).optional(),
  subagentDepth: z.number().int().min(0).max(10).optional(),
});

const userSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

const mediaGenSchema = z.object({
  provider: z.string().min(1).max(100).optional(),
  account: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
  params: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
    .optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
});

const modelsSchema = z.object({
  default: z.string().optional(),
  title: z.string().optional(),
  defaultAccount: z.record(z.string(), z.string().min(1).max(100)).optional(),
  preferZdr: z.boolean().optional(),
  maxOutputTokens: z.number().int().min(256).max(200_000).optional(),
});

const toolsSchema = z.object({
  webSearch: z
    .object({
      provider: z.enum(["auto", "exa", "parallel", "ddgs"]).optional(),
      keylessFallback: z.boolean().optional(),
    })
    .optional(),
});

const themeSchema = z.string().min(1).max(100);

const jobsSchema = z.object({
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  videoTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backoffMs: z.number().int().min(0).max(600_000).optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
});

const routerSchema = z.object({
  enabled: z.boolean().optional(),
});

export const configSchema = z.object({
  providers: z.record(z.string(), providerSchema).default({}),
  models: modelsSchema.default({}),
  agents: agentsSchema.default({}),
  user: userSchema.default({}),
  theme: themeSchema.optional(),
  imageGen: mediaGenSchema.optional(),
  videoGen: mediaGenSchema.optional(),
  permissions: z.record(z.string(), z.enum(["allow", "ask", "deny"])).default({}),
  mcp: z.record(z.string(), mcpServerSchema).default({}),
  workbenches: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  workspaces: z.array(z.string().min(1).max(1024)).max(100).default([]),
  workspaceFolders: z
    .record(z.string().min(1).max(1024), z.array(z.string().min(1).max(1024)).max(100))
    .default({}),
  archivedWorkspaces: z.array(z.string().min(1).max(1024)).max(100).default([]),
  server: z
    .object({
      port: z.number().int().positive().max(65535).optional(),
      token: z.string().min(16).optional(),
    })
    .default({}),
  tools: toolsSchema.default({}),
  jobs: jobsSchema.default({}),
  router: routerSchema.default({}),
});
/** Accepts a partial config document (used by PUT /api/config and file layers). */
export const configPatchSchema = z.object({
  providers: z.record(z.string(), providerSchema).optional(),
  models: modelsSchema.optional(),
  agents: agentsSchema.optional(),
  user: userSchema.optional(),
  theme: themeSchema.optional(),
  imageGen: mediaGenSchema.optional(),
  videoGen: mediaGenSchema.optional(),
  permissions: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
  mcp: z.record(z.string(), mcpServerSchema).optional(),
  workbenches: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  workspaces: z.array(z.string().min(1).max(1024)).max(100).optional(),
  workspaceFolders: z
    .record(z.string().min(1).max(1024), z.array(z.string().min(1).max(1024)).max(100))
    .optional(),
  archivedWorkspaces: z.array(z.string().min(1).max(1024)).max(100).optional(),
  server: z
    .object({
      port: z.number().int().positive().max(65535).optional(),
      token: z.string().min(16).optional(),
    })
    .optional(),
  tools: toolsSchema.optional(),
  jobs: jobsSchema.optional(),
  router: routerSchema.optional(),
});

export type ConfigPatch = z.infer<typeof configPatchSchema>;

/** Deep-merge plain objects; later values win; arrays are replaced. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
