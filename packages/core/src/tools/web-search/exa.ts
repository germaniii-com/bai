import type { ExtractOutcome, SearchOutcome, SearchResult, WebSearchProvider } from "./provider";
import { callMcp, mcpErrorMessage } from "./mcp-http";

/**
 * exa — search/extract over Exa's public MCP endpoint (opencode's websearch
 * port: JSON-RPC `tools/call` against https://mcp.exa.ai/mcp). Keyed via the
 * documented `x-api-key` header when EXA_API_KEY is present; otherwise the
 * public keyless free tier (rate-limited). The `web_search_exa` tool accepts
 * only `{ query, numResults }` and returns `---`-delimited text blocks —
 * opencode's extra `type`/`livecrawl` args are stale and deliberately omitted.
 */

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

export interface ExaOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  /** Keyless public free tier enabled (default true). */
  keyless?: boolean;
}

interface ExaJsonResult {
  title?: string;
  url?: string;
  text?: string;
}

function fromJson(value: unknown): SearchResult[] | undefined {
  const rows = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results)
      ? ((value as { results: unknown[] }).results)
      : undefined;
  if (rows === undefined) return undefined;
  return rows
    .filter((r): r is ExaJsonResult => typeof r === "object" && r !== null)
    .map((r) => ({ title: r.title ?? "(untitled)", url: r.url ?? "", description: r.text ?? "" }))
    .filter((r) => r.url.length > 0);
}

/** Parse Exa's `---`-delimited formatted text (hermes `_parse_exa_search_text`). */
function fromBlocks(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of text.split("\n---\n")) {
    let title = "";
    let url = "";
    const highlights: string[] = [];
    let inHighlights = false;
    for (const line of block.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("Title:")) {
        title = stripped.slice("Title:".length).trim();
        inHighlights = false;
      } else if (stripped.startsWith("URL:")) {
        url = stripped.slice("URL:".length).trim();
        inHighlights = false;
      } else if (stripped.startsWith("Highlights:")) {
        inHighlights = true;
      } else if (stripped.startsWith("Published:") || stripped.startsWith("Author:")) {
        inHighlights = false;
      } else if (inHighlights && stripped.length > 0) {
        highlights.push(stripped);
      }
    }
    if (url.length > 0) results.push({ title: title.length > 0 ? title : url, url, description: highlights.join(" ") });
  }
  return results;
}

export function parseExaResults(text: string, limit: number): SearchResult[] {
  let parsed: SearchResult[] | undefined;
  try {
    parsed = fromJson(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  const results = parsed ?? fromBlocks(text);
  return results.slice(0, limit);
}

function firstHeading(text: string): string {
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("# ")) return stripped.slice(2).trim();
    if (stripped.startsWith("Title:")) return stripped.slice("Title:".length).trim();
  }
  return "";
}

export function exaProvider(opts: ExaOptions = {}): WebSearchProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.EXA_API_KEY ?? "";
  const keyless = opts.keyless ?? true;
  const headers: Record<string, string> = apiKey.length > 0 ? { "x-api-key": apiKey } : {};
  const call = (tool: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    callMcp({ url: EXA_MCP_URL, tool, args, headers, fetchImpl: doFetch, signal });
  return {
    name: "exa",
    isAvailable: () => apiKey.length > 0 || keyless,
    isKeyed: () => apiKey.length > 0,
    isKeylessAvailable: () => keyless,
    supportsExtract: () => true,
    note: () =>
      apiKey.length > 0
        ? "Exa (keyed via EXA_API_KEY)"
        : "set EXA_API_KEY for higher Exa limits (the keyless free tier is rate-limited)",
    async search(query, limit, o): Promise<SearchOutcome> {
      if (apiKey.length === 0 && !keyless) return { success: false, error: "Exa search requires EXA_API_KEY." };
      try {
        const text = (await call("web_search_exa", { query, numResults: limit }, o?.signal)) ?? "";
        return { success: true, results: parseExaResults(text, limit) };
      } catch (err) {
        return { success: false, error: `Exa search failed: ${mcpErrorMessage(err)}` };
      }
    },
    async extract(urls, o): Promise<ExtractOutcome> {
      const results = [];
      for (const url of urls) {
        try {
          const text = (await call("web_fetch_exa", { urls: [url] }, o?.signal)) ?? "";
          results.push({ url, title: firstHeading(text) || url, content: text });
        } catch (err) {
          return { success: false, error: `Exa extract failed: ${mcpErrorMessage(err)}` };
        }
      }
      return { success: true, results };
    },
  };
}
