import { z } from "zod";
import type { PermissionAction } from "./enums";
import type { AdapterName } from "./providers";

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
}

export interface AgentsConfig {
  /**
   * Default agent for sessions that select none (new sessions, surfaces that
   * never picked one). Resolution order at drain: session meta → this → the
   * built-in `build` agent. Unknown names fall back to `build` with a warning.
   */
  default?: string;
}

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface ServerConfig {
  port?: number;
  token?: string;
}

export interface ToolsConfig {
  /** Web search provider selection (default: ddgs — keyless DuckDuckGo). */
  webSearch?: {
    /** "ddgs" (keyless, default) or "exa" (needs EXA_API_KEY). */
    provider?: "ddgs" | "exa";
  };
}

export interface Config {
  providers: Record<string, ProviderConfig>;
  models: ModelsConfig;
  agents: AgentsConfig;
  permissions: Record<string, PermissionAction>;
  mcp: Record<string, MCPServerConfig>;
  workbenches: Record<string, Record<string, unknown>>;
  /** Registered workspace folder paths (absolute); the web Workspace view
   * groups cwd-rooted sessions by these. Edited via PUT /api/config. */
  workspaces: string[];
  server: ServerConfig;
  tools: ToolsConfig;
}

export const DEFAULT_CONFIG: Config = {
  providers: {},
  models: {},
  agents: {},
  permissions: {},
  mcp: {},
  workbenches: {},
  workspaces: [],
  server: {},
  tools: {},
};

const providerSchema = z.object({
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  adapter: z.enum(["openai", "anthropic", "openai-compatible"]).optional(),
  name: z.string().min(1).max(100).optional(),
  models: z.array(z.string().min(1).max(200)).max(1000).optional(),
});

const mcpServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const agentsSchema = z.object({
  default: z.string().max(100).optional(),
});

const toolsSchema = z.object({
  webSearch: z
    .object({
      provider: z.enum(["ddgs", "exa"]).optional(),
    })
    .optional(),
});

export const configSchema = z.object({
  providers: z.record(z.string(), providerSchema).default({}),
  models: z
    .object({
      default: z.string().optional(),
      title: z.string().optional(),
      defaultAccount: z.record(z.string(), z.string().min(1).max(100)).optional(),
    })
    .default({}),
  agents: agentsSchema.default({}),
  permissions: z.record(z.string(), z.enum(["allow", "ask", "deny"])).default({}),
  mcp: z.record(z.string(), mcpServerSchema).default({}),
  workbenches: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  workspaces: z.array(z.string().min(1).max(1024)).max(100).default([]),
  server: z
    .object({
      port: z.number().int().positive().max(65535).optional(),
      token: z.string().min(16).optional(),
    })
    .default({}),
  tools: toolsSchema.default({}),
});

/** Accepts a partial config document (used by PUT /api/config and file layers). */
export const configPatchSchema = z.object({
  providers: z.record(z.string(), providerSchema).optional(),
  models: z
    .object({
      default: z.string().optional(),
      title: z.string().optional(),
      defaultAccount: z.record(z.string(), z.string().min(1).max(100)).optional(),
    })
    .optional(),
  agents: agentsSchema.optional(),
  permissions: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
  mcp: z.record(z.string(), mcpServerSchema).optional(),
  workbenches: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  workspaces: z.array(z.string().min(1).max(1024)).max(100).optional(),
  server: z
    .object({
      port: z.number().int().positive().max(65535).optional(),
      token: z.string().min(16).optional(),
    })
    .optional(),
  tools: toolsSchema.optional(),
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
