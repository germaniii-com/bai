import { search as ddgsSearch, SafeSearchType } from "duck-duck-scrape";
import type { SearchOutcome, WebSearchProvider } from "./provider";

/**
 * ddgs — keyless DuckDuckGo search via the `duck-duck-scrape` scraper
 * (the JS analog of hermes's `ddgs` PyPI provider). No API key, always
 * available. DuckDuckGo enforces its own server-side rate limits; transient
 * "anomaly" failures get one short retry, and everything surfaces through
 * the never-raise outcome contract.
 */

const RETRY_DELAY_MS = 1500;

export function ddgsProvider(): WebSearchProvider {
  return {
    name: "ddgs",
    isAvailable: () => true,
    note: () => "keyless DuckDuckGo search — rate-limited server-side; retry later or configure tools.webSearch.provider",
    async search(query, limit) {
      const attempt = async (): Promise<SearchOutcome> => {
        const res = await ddgsSearch(query, { safeSearch: SafeSearchType.OFF, locale: "en-us" });
        if (res.noResults || res.results.length === 0) return { success: true, results: [] };
        const results = res.results.slice(0, limit).map((r, i) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          description: r.description ?? "",
          position: i + 1,
        }));
        return { success: true, results };
      };
      try {
        return await attempt();
      } catch (first) {
        // One backoff-and-retry for transient rate-limit anomalies.
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        try {
          return await attempt();
        } catch (second) {
          const message = second instanceof Error ? second.message : String(second);
          return { success: false, error: `DuckDuckGo search failed: ${message}` };
        }
      }
    },
  };
}
