import { search as ddgsSearch, SafeSearchType } from "duck-duck-scrape";
import type { ExtractOutcome, ProviderCallOptions, SearchOutcome, SearchResult, WebSearchProvider } from "./provider";

/**
 * ddgs — keyless DuckDuckGo search via the `duck-duck-scrape` scraper.
 *
 * Deprecated to LAST RESORT: the scraper is unmaintained and DuckDuckGo
 * frequently answers with anomaly/rate-limit pages or markup the parser no
 * longer recognizes. It runs with a hard wall-clock cap (the underlying
 * `needle` request has no timeout of its own) and surfaces every failure as a
 * `{success:false}` outcome so the ladder can fall through to a working
 * provider. Search-only.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

type SearchImpl = typeof ddgsSearch;

export interface DdgsOptions {
  searchImpl?: SearchImpl;
  timeoutMs?: number;
}

class TimeoutError extends Error {
  constructor() {
    super("DuckDuckGo search timed out");
    this.name = "TimeoutError";
  }
}

/** Reject after `ms`, or when `signal` aborts; never leaves a dangling timer. */
function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(new TimeoutError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    const onAbort = (): void => reject(new TimeoutError());
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function classify(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof TimeoutError) {
    return "DuckDuckGo timed out — it may be rate-limiting or slow. Retry later or configure an Exa/Parallel key for reliable service.";
  }
  if (/anomaly|too quickly|rate.?limit|429/i.test(message)) {
    return "DuckDuckGo rate-limited this request (anomaly detection). Retry later or configure an EXA_API_KEY / PARALLEL_API_KEY.";
  }
  return `DuckDuckGo search failed: ${message}`;
}

export function ddgsProvider(opts: DdgsOptions = {}): WebSearchProvider {
  const doSearch = opts.searchImpl ?? ddgsSearch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: "ddgs",
    isAvailable: () => true,
    isKeyed: () => false,
    isKeylessAvailable: () => true,
    supportsExtract: () => false,
    note: () => "keyless DuckDuckGo scraper (last resort — frequently rate-limited)",
    async search(query, limit, o?: ProviderCallOptions): Promise<SearchOutcome> {
      try {
        const res = await withTimeout(
          doSearch(query, { safeSearch: SafeSearchType.OFF, locale: "en-us" }),
          timeoutMs,
          o?.signal,
        );
        if (res.noResults || res.results.length === 0) return { success: true, results: [] };
        const results: SearchResult[] = res.results.slice(0, limit).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          description: r.description ?? "",
        }));
        return { success: true, results };
      } catch (err) {
        return { success: false, error: classify(err) };
      }
    },
    async extract(): Promise<ExtractOutcome> {
      return { success: false, error: "DuckDuckGo provider does not support extract." };
    },
  };
}
