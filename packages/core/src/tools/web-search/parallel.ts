import type { ExtractOutcome, SearchOutcome, SearchResult, WebSearchProvider } from "./provider";
import { callMcp, mcpErrorMessage } from "./mcp-http";

/**
 * parallel — search/extract over Parallel's public MCP endpoint
 * (https://search.parallel.ai/mcp). Anonymous/free by default; a
 * PARALLEL_API_KEY adds an `Authorization: Bearer` header for higher limits.
 * `web_search` takes `{ objective, search_queries, session_id }` and returns
 * JSON `{results:[{url,title,excerpts}]}`; `web_fetch` takes `{urls,...}`.
 */

const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

/** Per-process free-tier rate-limit correlation id (never persisted). */
const SESSION_ID = crypto.randomUUID().replace(/-/g, "");

export interface ParallelOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  /** Keyless public free tier enabled (default true). */
  keyless?: boolean;
  sessionId?: string;
}

interface ParallelRow {
  url?: string;
  title?: string;
  excerpts?: unknown;
  full_content?: string;
  content?: string;
}

function joinExcerpts(row: ParallelRow): string {
  const excerpts = Array.isArray(row.excerpts) ? row.excerpts.filter((e): e is string => typeof e === "string") : [];
  return excerpts.join(" ").trim();
}

function parseRows(text: string): ParallelRow[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) return [];
  const rows = (data as { results?: unknown }).results;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is ParallelRow => typeof r === "object" && r !== null);
}

export function parseParallelResults(text: string, limit: number): SearchResult[] {
  return parseRows(text)
    .map((row) => ({ title: row.title ?? "(untitled)", url: row.url ?? "", description: joinExcerpts(row) }))
    .filter((r) => r.url.length > 0)
    .slice(0, limit);
}

export function parallelProvider(opts: ParallelOptions = {}): WebSearchProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.PARALLEL_API_KEY ?? "";
  const keyless = opts.keyless ?? true;
  const sessionId = opts.sessionId ?? SESSION_ID;
  const headers: Record<string, string> = {
    "User-Agent": "bai",
    ...(apiKey.length > 0 ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  const call = (tool: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    callMcp({ url: PARALLEL_MCP_URL, tool, args, headers, fetchImpl: doFetch, signal });
  return {
    name: "parallel",
    isAvailable: () => apiKey.length > 0 || keyless,
    isKeyed: () => apiKey.length > 0,
    isKeylessAvailable: () => keyless,
    supportsExtract: () => true,
    note: () =>
      apiKey.length > 0
        ? "Parallel (keyed via PARALLEL_API_KEY)"
        : "set PARALLEL_API_KEY for higher Parallel limits (the keyless free tier is rate-limited)",
    async search(query, limit, o): Promise<SearchOutcome> {
      if (apiKey.length === 0 && !keyless) return { success: false, error: "Parallel search requires PARALLEL_API_KEY." };
      try {
        const text =
          (await call(
            "web_search",
            { objective: query, search_queries: [query], session_id: sessionId },
            o?.signal,
          )) ?? "";
        return { success: true, results: parseParallelResults(text, limit) };
      } catch (err) {
        return { success: false, error: `Parallel search failed: ${mcpErrorMessage(err)}` };
      }
    },
    async extract(urls, o): Promise<ExtractOutcome> {
      try {
        const text = (await call("web_fetch", { urls, session_id: sessionId }, o?.signal)) ?? "";
        const results = parseRows(text).map((row) => ({
          url: row.url ?? "",
          title: row.title ?? row.url ?? "",
          content: row.full_content ?? row.content ?? joinExcerpts(row),
        }));
        return { success: true, results };
      } catch (err) {
        return { success: false, error: `Parallel extract failed: ${mcpErrorMessage(err)}` };
      }
    },
  };
}
