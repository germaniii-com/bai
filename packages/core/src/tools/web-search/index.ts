import type { Config, WebSearchProviderId, WebSearchStatus } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "../registry";
import type { ExtractOutcome, SearchOutcome, WebSearchProvider } from "./provider";
import { ddgsProvider } from "./ddgs";
import { exaProvider, type ExaOptions } from "./exa";
import { parallelProvider, type ParallelOptions } from "./parallel";

export type { ExtractOutcome, ExtractResult, ProviderCallOptions, SearchOutcome, SearchResult, WebSearchProvider } from "./provider";
export { ddgsProvider } from "./ddgs";
export { exaProvider } from "./exa";
export { parallelProvider } from "./parallel";
export { parseExaResults } from "./exa";
export { parseParallelResults } from "./parallel";
export { McpError, parseMcpText } from "./mcp-http";

type ProviderName = "exa" | "parallel" | "ddgs";

/**
 * Provider selection ladder (opencode's backends + hermes's keyless fallback):
 *
 *   auto / exa  →  exa → parallel → ddgs
 *   parallel    →  parallel → exa → ddgs
 *   ddgs        →  ddgs → exa → parallel
 *
 * Exa and Parallel work keyless (public free tiers) or keyed; ddgs is a
 * hardened last resort. A failure of one provider falls through to the next.
 */
const LADDERS: Record<WebSearchProviderId, readonly [ProviderName, ProviderName, ProviderName]> = {
  auto: ["exa", "parallel", "ddgs"],
  exa: ["exa", "parallel", "ddgs"],
  parallel: ["parallel", "exa", "ddgs"],
  ddgs: ["ddgs", "exa", "parallel"],
};

export function resolveSearchProviders(config?: Config): WebSearchProvider[] {
  const ws = config?.tools?.webSearch;
  const keylessFallback = ws?.keylessFallback !== false;
  const configured: WebSearchProviderId = ws?.provider ?? "auto";
  const exa = exaProvider({ keyless: keylessFallback });
  const parallel = parallelProvider({ keyless: keylessFallback });
  const ddgs = ddgsProvider();
  const all: Record<ProviderName, WebSearchProvider> = { exa, parallel, ddgs };
  const ladder = LADDERS[configured].map((name) => all[name]);
  const available = ladder.filter((p) => p.isAvailable());
  // keylessFallback:false drops keyless-only providers unless one is pinned.
  return keylessFallback ? available : available.filter((p) => p.isKeyed() || p.name === configured);
}

// ---------------------------------------------------------------------------
// Success-only TTL cache (repeated agent queries hammer the keyless tiers).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;
type OkOutcome = Extract<SearchOutcome, { success: true }>;
interface CacheEntry {
  outcome: OkOutcome;
  ts: number;
}
const searchCache = new Map<string, CacheEntry>();

/** Test hook. */
export function clearSearchCache(): void {
  searchCache.clear();
}

function cacheKey(name: string, query: string, limit: number): string {
  return `${name}\u0000${limit}\u0000${query}`;
}

function readCache(name: string, query: string, limit: number): OkOutcome | undefined {
  const key = cacheKey(name, query, limit);
  const entry = searchCache.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    searchCache.delete(key);
    return undefined;
  }
  return entry.outcome;
}

function writeCache(name: string, query: string, limit: number, outcome: OkOutcome): void {
  if (outcome.results.length === 0) return;
  searchCache.set(cacheKey(name, query, limit), { outcome, ts: Date.now() });
}

// ---------------------------------------------------------------------------

export interface WebSearchToolOptions {
  config(): Config;
  /** Provider override (tests); default resolves from config + env. */
  providers?: WebSearchProvider[];
}

export function webSearchTool(opts: WebSearchToolOptions): Tool {
  const providers = () => opts.providers ?? resolveSearchProviders(opts.config());
  return {
    name: "web.search",
    origin: "builtin",
    description:
      "Search the web and return ranked results (title, url, description). " +
      "Uses Exa/Parallel (keyless or keyed) with a DuckDuckGo last resort. " +
      "Use for current events, docs lookups, and anything outside your knowledge. " +
      "Follow up with web.fetch to read a promising result in full.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "number", description: "Number of results, 1-10 (default 5)" },
      },
      required: ["query"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { query, limit } = args as { query?: string; limit?: number };
      if (typeof query !== "string" || query.trim().length === 0) {
        throw new Error("query is required");
      }
      const trimmed = query.trim();
      const bounded = Math.max(1, Math.min(10, Math.floor(limit ?? 5)));
      const tried = providers().filter((p) => p.isAvailable());
      if (tried.length === 0) {
        throw new Error(
          "No web search provider is available. Set EXA_API_KEY or PARALLEL_API_KEY, " +
            "or enable the keyless fallback (tools.webSearch.keylessFallback).",
        );
      }
      const failures: string[] = [];
      for (const provider of tried) {
        const cached = readCache(provider.name, trimmed, bounded);
        const outcome: SearchOutcome =
          cached ?? (await provider.search(trimmed, bounded, { signal: ctx.signal }));
        if (!outcome.success) {
          failures.push(`${provider.name}: ${outcome.error}`);
          continue;
        }
        if (outcome.results.length === 0) {
          return {
            content: `No results for "${trimmed}". Try a different phrasing.`,
            meta: { provider: provider.name, count: 0 },
          };
        }
        writeCache(provider.name, trimmed, bounded, outcome);
        const lines = outcome.results.map(
          (r, i) => `${i + 1}. ${r.title}${r.url ? `\n   ${r.url}` : ""}\n   ${r.description}`,
        );
        return {
          content: lines.join("\n\n"),
          meta: {
            provider: provider.name,
            tier: provider.isKeyed() ? "keyed" : "keyless",
            count: outcome.results.length,
            title: `Searched: ${trimmed}`,
          },
        };
      }
      const hints = tried
        .map((p) => p.note())
        .filter((n) => n.length > 0)
        .join("; ");
      throw new Error(
        `Web search failed (${tried.map((p) => p.name).join(", ")}): ${failures.join("; ")}${hints.length > 0 ? `. ${hints}` : ""}`,
      );
    },
  };
}

/**
 * web.fetch's fallback: extract page content via the first available
 * MCP extract-capable provider (Exa `web_fetch_exa` / Parallel `web_fetch`).
 */
export async function extractWithFallback(
  config: Config | undefined,
  urls: string[],
  signal?: AbortSignal,
): Promise<ExtractOutcome> {
  const providers = resolveSearchProviders(config).filter((p) => p.supportsExtract() && p.isAvailable());
  if (providers.length === 0) return { success: false, error: "No extract-capable web provider is available." };
  const failures: string[] = [];
  for (const provider of providers) {
    const outcome = await provider.extract(urls, { signal });
    if (!outcome.success) {
      failures.push(`${provider.name}: ${outcome.error}`);
      continue;
    }
    if (outcome.results.length === 0) {
      failures.push(`${provider.name}: no content returned`);
      continue;
    }
    return outcome;
  }
  return { success: false, error: `Extract failed (${providers.map((p) => p.name).join(", ")}): ${failures.join("; ")}` };
}

/** Read-only provider/key state for the Web Search settings pane. */
export function webSearchStatus(config?: Config): WebSearchStatus {
  const ws = config?.tools?.webSearch;
  return {
    provider: ws?.provider ?? "auto",
    keylessFallback: ws?.keylessFallback !== false,
    keys: {
      exa: (process.env.EXA_API_KEY ?? "").length > 0,
      parallel: (process.env.PARALLEL_API_KEY ?? "").length > 0,
    },
    available: resolveSearchProviders(config).map((p) => p.name),
  };
}

export type { ExaOptions, ParallelOptions };
