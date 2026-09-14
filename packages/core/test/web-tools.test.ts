import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { webFetchTool } from "../src/tools/web-fetch";
import {
  clearSearchCache,
  ddgsProvider,
  exaProvider,
  parallelProvider,
  parseMcpText,
  resolveSearchProviders,
  webSearchTool,
  type WebSearchProvider,
} from "../src/tools/web-search";
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

/** A JSON-RPC MCP response envelope carrying a text payload. */
function mcpEnvelope(text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

const ENV_KEYS = ["EXA_API_KEY", "PARALLEL_API_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

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

  test("falls back to MCP extract when a direct fetch fails", async () => {
    const fetchImpl = mockFetch({});
    let calledWith: string[] = [];
    const t = webFetchTool({
      fetchImpl,
      extractFallback: async (urls) => {
        calledWith = urls;
        return { success: true, results: [{ url: urls[0] ?? "", title: "From MCP", content: "readable body" }] };
      },
    });
    const result = await t.execute({ url: "https://example.com/blocked" }, {} as never);
    expect(calledWith).toEqual(["https://example.com/blocked"]);
    expect(result.content).toContain("From MCP");
    expect(result.content).toContain("readable body");
    expect((result.meta as { provider: string }).provider).toBe("mcp");
  });

  test("html format never uses the extract fallback", async () => {
    let called = false;
    const t = webFetchTool({
      fetchImpl: mockFetch({}),
      extractFallback: async () => {
        called = true;
        return { success: true, results: [{ url: "https://example.com/x", title: "t", content: "c" }] };
      },
    });
    await expect(t.execute({ url: "https://example.com/x", format: "html" }, {} as never)).rejects.toThrow(/mockFetch/);
    expect(called).toBe(false);
  });

  test("a failed fallback preserves the original fetch error", async () => {
    const t = webFetchTool({
      fetchImpl: mockFetch({}),
      extractFallback: async () => ({ success: false, error: "also down" }),
    });
    await expect(t.execute({ url: "https://example.com/x" }, {} as never)).rejects.toThrow(/mockFetch/);
  });
});

describe("web.search", () => {
  const configWith = (tools: Config["tools"]): Config => ({ ...DEFAULT_CONFIG, tools });

  // The cache is module-global — isolate every test.
  beforeEach(() => clearSearchCache());

  const fakeProvider = (
    name: string,
    behavior: WebSearchProvider["search"],
    overrides: Partial<WebSearchProvider> = {},
  ): WebSearchProvider => ({
    name,
    isAvailable: () => true,
    isKeyed: () => true,
    isKeylessAvailable: () => false,
    supportsExtract: () => false,
    note: () => "",
    search: behavior,
    extract: async () => ({ success: false, error: "no extract" }),
    ...overrides,
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

  test("caches successful results for identical queries", async () => {
    let calls = 0;
    const provider = fakeProvider("mock", async () => {
      calls += 1;
      return { success: true, results: [{ title: "R", url: "https://a/1", description: "d" }] };
    });
    const t = webSearchTool({ config: () => configWith({}), providers: [provider] });
    await t.execute({ query: "same", limit: 3 }, {} as never);
    await t.execute({ query: "same", limit: 3 }, {} as never);
    expect(calls).toBe(1);
  });

  test("provider ladder: auto/default", () => {
    expect(resolveSearchProviders(configWith({})).map((p) => p.name)).toEqual(["exa", "parallel", "ddgs"]);
  });

  test("provider ladder: pinned providers go first", () => {
    expect(resolveSearchProviders(configWith({ webSearch: { provider: "exa" } })).map((p) => p.name)).toEqual([
      "exa",
      "parallel",
      "ddgs",
    ]);
    expect(resolveSearchProviders(configWith({ webSearch: { provider: "parallel" } })).map((p) => p.name)).toEqual([
      "parallel",
      "exa",
      "ddgs",
    ]);
    expect(resolveSearchProviders(configWith({ webSearch: { provider: "ddgs" } })).map((p) => p.name)).toEqual([
      "ddgs",
      "exa",
      "parallel",
    ]);
  });

  test("keylessFallback:false drops keyless providers when no key is set", () => {
    expect(resolveSearchProviders(configWith({ webSearch: { keylessFallback: false } }))).toEqual([]);
  });

  test("keylessFallback:false keeps a keyed provider", () => {
    process.env.EXA_API_KEY = "test-key";
    try {
      expect(resolveSearchProviders(configWith({ webSearch: { keylessFallback: false } })).map((p) => p.name)).toEqual([
        "exa",
      ]);
    } finally {
      delete process.env.EXA_API_KEY;
    }
  });
});

describe("mcp-http parsing", () => {
  test("reads direct JSON and SSE payloads", () => {
    expect(parseMcpText(mcpEnvelope("hi"))).toBe("hi");
    expect(parseMcpText(`event: message\ndata: ${mcpEnvelope("sse")}\n`)).toBe("sse");
  });

  test("throws on tool errors and JSON-RPC errors", () => {
    expect(() => parseMcpText(JSON.stringify({ result: { isError: true, content: [{ text: "boom" }] } }))).toThrow(/boom/);
    expect(() => parseMcpText(JSON.stringify({ error: { message: "bad request" } }))).toThrow(/bad request/);
  });
});

describe("exa provider", () => {
  test("keyless is available without a key; keyed reports keyed", () => {
    const keyless = exaProvider({ apiKey: "" });
    expect(keyless.isAvailable()).toBe(true);
    expect(keyless.isKeyed()).toBe(false);
    const keyed = exaProvider({ apiKey: "k" });
    expect(keyed.isKeyed()).toBe(true);
  });

  test("parses the --- delimited text blocks", async () => {
    const text = "Title: First\nURL: https://e/1\nPublished: N/A\nAuthor: N/A\nHighlights:\nsome highlight\nmore\n\n---\n\nTitle: Second\nURL: https://e/2\nHighlights:\nsecond";
    const fetchImpl = mockFetch({
      "https://mcp.exa.ai/mcp": { headers: { "Content-Type": "application/json" }, body: mcpEnvelope(text) },
    });
    const out = await exaProvider({ fetchImpl, apiKey: "k" }).search("q", 5);
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.results[0]?.url).toBe("https://e/1");
      expect(out.results[0]?.title).toBe("First");
      expect(out.results[0]?.description).toContain("some highlight");
      expect(out.results[1]?.title).toBe("Second");
    }
  });

  test("parses a JSON-array text payload", async () => {
    const fetchImpl = mockFetch({
      "https://mcp.exa.ai/mcp": {
        headers: { "Content-Type": "application/json" },
        body: mcpEnvelope(JSON.stringify([{ title: "Exa hit", url: "https://e/1", text: "snippet" }])),
      },
    });
    const out = await exaProvider({ fetchImpl, apiKey: "k" }).search("q", 5);
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.results[0]?.title).toBe("Exa hit");
      expect(out.results[0]?.url).toBe("https://e/1");
    }
  });

  test("MCP error becomes a failure outcome", async () => {
    const fetchImpl = mockFetch({
      "https://mcp.exa.ai/mcp": { status: 429, body: JSON.stringify({ error: { message: "rate limit" } }) },
    });
    const out = await exaProvider({ fetchImpl, apiKey: "k" }).search("q", 5);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.error).toMatch(/429|rate limit/);
  });
});

describe("parallel provider", () => {
  test("parses {results:[{url,title,excerpts}]}", async () => {
    const fetchImpl = mockFetch({
      "https://search.parallel.ai/mcp": {
        headers: { "Content-Type": "application/json" },
        body: mcpEnvelope(JSON.stringify({ results: [{ url: "https://p/1", title: "P1", excerpts: ["a", "b"] }] })),
      },
    });
    const out = await parallelProvider({ fetchImpl, apiKey: "k", sessionId: "s" }).search("q", 5);
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.results[0]?.url).toBe("https://p/1");
      expect(out.results[0]?.description).toBe("a b");
    }
  });

  test("MCP error becomes a failure outcome", async () => {
    const fetchImpl = mockFetch({
      "https://search.parallel.ai/mcp": { status: 500, body: "upstream boom" },
    });
    const out = await parallelProvider({ fetchImpl, apiKey: "k" }).search("q", 5);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.error).toMatch(/500/);
  });
});

describe("ddgs provider", () => {
  test("times out instead of hanging", async () => {
    const hanging = (() => new Promise(() => {})) as never;
    const out = await ddgsProvider({ searchImpl: hanging, timeoutMs: 20 }).search("q", 5);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.error).toMatch(/timed out/i);
  });

  test("classifies anomaly/rate-limit errors", async () => {
    const thrower = (() => {
      throw new Error("DDG detected an anomaly in the request");
    }) as never;
    const out = await ddgsProvider({ searchImpl: thrower }).search("q", 5);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.error).toMatch(/rate-limited/i);
  });

  test("maps native results", async () => {
    const impl = (async () => ({
      noResults: false,
      results: [{ title: "T", url: "https://d/1", description: "D" }],
    })) as never;
    const out = await ddgsProvider({ searchImpl: impl }).search("q", 5);
    expect(out.success).toBe(true);
    if (out.success) expect(out.results).toEqual([{ title: "T", url: "https://d/1", description: "D" }]);
  });

  test("does not support extract", async () => {
    const out = await ddgsProvider().extract(["https://x"]);
    expect(out.success).toBe(false);
  });
});
