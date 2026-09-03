import type { Config } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "../registry";
import type { WebSearchProvider } from "./provider";
import { ddgsProvider } from "./ddgs";
import { exaProvider } from "./exa";

export type { SearchOutcome, SearchResult, WebSearchProvider } from "./provider";
export { ddgsProvider } from "./ddgs";
export { exaProvider } from "./exa";

/**
 * Provider selection ladder (hermes's registry resolution, bai-simplified):
 *
 *   config.tools.webSearch.provider  →  ddgs (keyless default)
 *
 * plus graceful degradation: a ddgs failure falls back to Exa when
 * EXA_API_KEY is present, and vice versa when the config pins exa. The
 * fallback is automatic so a rate-limited DuckDuckGo never strands the agent
 * while a keyed provider sits unused.
 */
export function resolveSearchProviders(config?: Config): WebSearchProvider[] {
  const ddgs = ddgsProvider();
  const exa = exaProvider();
  const configured = config?.tools?.webSearch?.provider;
  if (configured === "exa") return [exa, ddgs];
  if (exa.isAvailable()) return [ddgs, exa]; // keyed fallback behind the keyless default
  return [ddgs];
}

export function webSearchTool(opts: {
  config(): Config;
  /** Provider override (tests); default resolves from config + env. */
  providers?: WebSearchProvider[];
}): Tool {
  const providers = () => {
    if (opts.providers !== undefined) return opts.providers;
    return resolveSearchProviders(opts.config());
  };
  return {
    name: "web.search",
    origin: "builtin",
    description:
      "Search the web and return ranked results (title, url, description). " +
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
      const bounded = Math.max(1, Math.min(10, Math.floor(limit ?? 5)));
      const tried = providers().filter((p) => p.isAvailable());
      if (tried.length === 0) {
        throw new Error("No web search provider is available. Set EXA_API_KEY for keyed search.");
      }
      const failures: string[] = [];
      for (const provider of tried) {
        const outcome = await provider.search(query.trim(), bounded);
        if (!outcome.success) {
          failures.push(`${provider.name}: ${outcome.error}`);
          continue;
        }
        if (outcome.results.length === 0) {
          return {
            content: `No results for "${query.trim()}". Try a different phrasing.`,
            meta: { provider: provider.name, count: 0 },
          };
        }
        const lines = outcome.results.map(
          (r, i) => `${i + 1}. ${r.title}${r.url ? `\n   ${r.url}` : ""}\n   ${r.description}`,
        );
        return {
          content: lines.join("\n\n"),
          meta: { provider: provider.name, count: outcome.results.length, title: `Searched: ${query.trim()}` },
        };
      }
      throw new Error(`Web search failed (${tried.map((p) => p.name).join(", ")}): ${failures.join("; ")}`);
    },
  };
}
