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
  /** Per-provider default account id, e.g. { "openai": "personal" }. */
  defaultAccount?: Record<string, string>;
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

export interface Config {
  providers: Record<string, ProviderConfig>;
  models: ModelsConfig;
  permissions: Record<string, PermissionAction>;
  mcp: Record<string, MCPServerConfig>;
  workbenches: Record<string, Record<string, unknown>>;
  server: ServerConfig;
}

export const DEFAULT_CONFIG: Config = {
  providers: {},
  models: {},
  permissions: {},
  mcp: {},
  workbenches: {},
  server: {},
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

export const configSchema = z.object({
  providers: z.record(z.string(), providerSchema).default({}),
  models: z
    .object({
      default: z.string().optional(),
      defaultAccount: z.record(z.string(), z.string().min(1).max(100)).optional(),
    })
    .default({}),
  permissions: z.record(z.string(), z.enum(["allow", "ask", "deny"])).default({}),
  mcp: z.record(z.string(), mcpServerSchema).default({}),
  workbenches: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  server: z
    .object({
      port: z.number().int().positive().max(65535).optional(),
      token: z.string().min(16).optional(),
    })
    .default({}),
});

/** Accepts a partial config document (used by PUT /api/config and file layers). */
export const configPatchSchema = z.object({
  providers: z.record(z.string(), providerSchema).optional(),
  models: z
    .object({
      default: z.string().optional(),
      defaultAccount: z.record(z.string(), z.string().min(1).max(100)).optional(),
    })
    .optional(),
  permissions: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
  mcp: z.record(z.string(), mcpServerSchema).optional(),
  workbenches: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  server: z
    .object({
      port: z.number().int().positive().max(65535).optional(),
      token: z.string().min(16).optional(),
    })
    .optional(),
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
