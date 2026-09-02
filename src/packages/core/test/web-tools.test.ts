import { describe, expect, test } from "bun:test";
import { webFetchTool } from "../src/tools/web-fetch";
import { webSearchTool, exaProvider, resolveSearchProviders, type WebSearchProvider } from "../src/tools/web-search";
import { DEFAULT_CONFIG, type Config } from "@bai/shared";

/** Mock fetch serving pre-scripted responses keyed by URL. */
function mockFetch(routes: Record<string, { status?: number; headers?: Record<string, string>; body: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];
    if (route === undefined) throw new Error(`mockFetch: no route for ${url}`);
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: route.headers ?? { "Content-Type": "text/html" },
    });
  }) as unknown as typeof fetch;
}

describe("web.fetch", () => {
  const tool = () => webFetchTool();

  const run = async (args: Record<string, unknown>, fetchImpl?: typeof fetch) => {
    const t = fetchImpl !== undefined ? webFetchTool({ fetchImpl }) : tool();
    return t.execute(args, {} as never);
  };

  test("url validation", async () => {
    await expect(run({ url: "ftp://x" })).rejects.toThrow(/http/);
    await expect(run({})).rejects.toThrow(/http/);
  });

  test("markdown: html converted via turndown", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/doc": { headers: { "Content-Type": "text/html; charset=utf-8" }, body: "<html><head><title>t</title></head><body><h1>Head</h1><p>para with <b>bold</b></p></body></html>" },
    });
    const result = await run({ url: "https://example.com/doc" }, fetchImpl);
    expect(result.content).toContain("https://example.com/doc (text/html");
    expect(result.content).toContain("# Head");
    expect(result.content).toContain("**bold**");
    expect(result.content).not.toContain("<h1>");
  });

  test("text: tags stripped, scripts skipped, whitespace normalized", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/txt": { body: "<p>hello</p><script>evil()</script><style>.x{}</style><p>  world </p>" },
    });
    const result = await run({ url: "https://example.com/txt", format: "text" }, fetchImpl);
    expect(result.content).toContain("hello");
    expect(result.content).toContain("world");
    expect(result.content).not.toContain("evil()");
    expect(result.content).not.toContain(".x{}");
  });

  test("html format returns raw markup", async () => {
    const fetchImpl = mockFetch({ "https://example.com/raw": { body: "<div><b>x</b></div>" } });
    const result = await run({ url: "https://example.com/raw", format: "html" }, fetchImpl);
    expect(result.content).toContain("<div>");
  });

  test("non-2xx becomes an error result", async () => {
    const fetchImpl = mockFetch({ "https://example.com/404": { status: 404, body: "nope" } });
    await expect(run({ url: "https://example.com/404" }, fetchImpl)).rejects.toThrow(/404/);
  });

  test("content-length over the cap is rejected before download", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/big": { headers: { "Content-Type": "text/html", "Content-Length": String(6 * 1024 * 1024) }, body: "small" },
    });
    await expect(run({ url: "https://example.com/big" }, fetchImpl)).rejects.toThrow(/5MB/);
  });

  test("403 with cf-mitigated challenge retries once with the honest UA", async () => {
    const calls: Array<{ url: string; ua: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(input), ua: headers["User-Agent"] ?? "" });
      if (calls.length === 1) {
        return new Response("blocked", { status: 403, headers: { "Content-Type": "text/html", "cf-mitigated": "challenge" } });
      }
      return new Response("<p>ok after retry</p>", { status: 200, headers: { "Content-Type": "text/html" } });
    }) as unknown as typeof fetch;
    const result = await run({ url: "https://example.com/cf" }, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.ua).not.toBe("bai");
    expect(calls[1]?.ua).toBe("bai");
    expect(result.content).toContain("ok after retry");
  });
});

describe("web.search", () => {
  const configWith = (tools: Config["tools"]): Config => ({ ...DEFAULT_CONFIG, tools });

  const fakeProvider = (name: string, behavior: () => Promise<{ success: true; results: Array<{ title: string; url: string; description: string }> } | { success: false; error: string }>): WebSearchProvider => ({
    name,
    isAvailable: () => true,
    note: () => "",
    search: behavior,
  });

  test("formats numbered results", async () => {
    const provider = fakeProvider("mock", async () => ({
      success: true,
      results: [
        { title: "First", url: "https://a.example/1", description: "the first one" },
        { title: "Second", url: "https://a.example/2", description: "the second" },
      ],
    }));
    const t = webSearchTool({ config: () => configWith({}), providers: [provider] });
    const result = await t.execute({ query: "test", limit: 2 }, {} as never);
    expect(result.content).toContain("1. First");
    expect(result.content).toContain("https://a.example/1");
    expect(result.content).toContain("2. Second");
    expect((result.meta as { provider: string }).provider).toBe("mock");
  });

  test("falls back to the next provider when the first fails", async () => {
    const failing = fakeProvider("flaky", async () => ({ success: false, error: "rate limited" }));
    const working = fakeProvider("backup", async () => ({ success: true, results: [{ title: "R", url: "https://b/1", description: "d" }] }));
    const t = webSearchTool({ config: () => configWith({}), providers: [failing, working] });
    const result = await t.execute({ query: "q" }, {} as never);
    expect(result.content).toContain("R");
    expect((result.meta as { provider: string }).provider).toBe("backup");
  });

  test("all providers failing → error result with the reasons", async () => {
    const failing = fakeProvider("flaky", async () => ({ success: false, error: "down" }));
    const t = webSearchTool({ config: () => configWith({}), providers: [failing] });
    await expect(t.execute({ query: "q" }, {} as never)).rejects.toThrow(/flaky: down/);
  });

  test("unavailable providers are skipped", async () => {
    const unavailable = fakeProvider("off", async () => ({ success: true, results: [] }));
    const available = fakeProvider("on", async () => ({ success: true, results: [{ title: "X", url: "", description: "" }] }));
    const t = webSearchTool({
      config: () => configWith({}),
      providers: [{ ...unavailable, isAvailable: () => false }, available],
    });
    const result = await t.execute({ query: "q" }, {} as never);
    expect((result.meta as { provider: string }).provider).toBe("on");
  });

  test("config pins exa: ladder is [exa, ddgs]; exa keyless skips to ddgs", () => {
    // No EXA_API_KEY in this environment → exa is unavailable, ddgs runs.
    const ladder = resolveSearchProviders(configWith({ webSearch: { provider: "exa" } }));
    expect(ladder.map((p) => p.name)).toEqual(["exa", "ddgs"]);
  });
});

describe("exa provider", () => {
  test("keyless → unavailable + explicit error on search", async () => {
    const p = exaProvider({ apiKey: "" });
    expect(p.isAvailable()).toBe(false);
    const out = await p.search("q", 5);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.error).toContain("EXA_API_KEY");
  });

  test("parses the MCP JSON-RPC response envelope", async () => {
    const fetchImpl = mockFetch({
      "https://mcp.exa.ai/mcp": {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify([{ title: "Exa hit", url: "https://e/1", text: "snippet" }]) }] },
        }),
      },
    });
    const p = exaProvider({ fetchImpl, apiKey: "test-key" });
    expect(p.isAvailable()).toBe(true);
    const out = await p.search("q", 5);
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.results[0]?.title).toBe("Exa hit");
      expect(out.results[0]?.url).toBe("https://e/1");
    }
  });
});
