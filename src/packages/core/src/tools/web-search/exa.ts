import type { SearchOutcome, WebSearchProvider } from "./provider";

/**
 * exa — keyed search over Exa's MCP endpoint (opencode's websearch port:
 * JSON-RPC `tools/call web_search_exa` against https://mcp.exa.ai/mcp,
 * 25s timeout). Available when EXA_API_KEY is present. Used as the
 * automatic fallback when the ddgs default fails with a key on hand.
 */

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_TIMEOUT_MS = 25_000;

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
}

export function exaProvider(opts: { fetchImpl?: typeof fetch; apiKey?: string } = {}): WebSearchProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.EXA_API_KEY ?? "";
  return {
    name: "exa",
    isAvailable: () => apiKey.length > 0,
    note: () => "set EXA_API_KEY to enable Exa search",
    async search(query, limit): Promise<SearchOutcome> {
      if (apiKey.length === 0) {
        return { success: false, error: "Exa search requires EXA_API_KEY (env var or config account)." };
      }
      try {
        const res = await doFetch(EXA_MCP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: { name: "web_search_exa", arguments: { query, numResults: limit } },
          }),
          signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
        });
        if (!res.ok) {
          return { success: false, error: `Exa search failed with status ${res.status}` };
        }
        const text = await res.text();
        // MCP HTTP may answer as JSON or SSE (data: lines) — handle both.
        let payload: unknown;
        if (text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")) {
          const dataLine = text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .filter((l) => l.length > 0 && l !== "[DONE]")
            .at(-1);
          payload = dataLine !== undefined ? JSON.parse(dataLine) : undefined;
        } else {
          payload = JSON.parse(text);
        }
        const result = (payload as { result?: { content?: Array<{ text?: string }> } })?.result;
        const raw = result?.content?.[0]?.text;
        if (typeof raw !== "string" || raw.length === 0) {
          return { success: true, results: [] };
        }
        // The MCP tool returns either a JSON array of results or prose; try JSON first.
        let results: Array<{ title: string; url: string; description: string }> = [];
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            results = (parsed as ExaResult[]).slice(0, limit).map((r, i) => ({
              title: r.title ?? "(untitled)",
              url: r.url ?? "",
              description: r.text ?? "",
              position: i + 1,
            }));
          }
        } catch {
          return { success: true, results: [{ title: query, url: "", description: raw.slice(0, 4000) }] };
        }
        return { success: true, results };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Exa search failed: ${message}` };
      }
    },
  };
}
