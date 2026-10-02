import { describe, expect, test } from "bun:test";
import { fetchRemoteModels, normalizeRemoteModels } from "../src/models";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake fetch routing on the request URL; records every call. */
function router(
  reply: (url: string) => Response | Promise<Response>,
  calls: Call[],
): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: { ...(rawHeaders ?? {}) } });
    return reply(String(url));
  }) as unknown as typeof globalThis.fetch;
}

describe("normalizeRemoteModels", () => {
  test("OpenAI { data } shape with names", () => {
    expect(
      normalizeRemoteModels({
        object: "list",
        data: [
          { id: "b-model", object: "model", owned_by: "acme" },
          { id: "a-model", object: "model", name: "A Model" },
        ],
      }),
    ).toEqual([{ id: "a-model", name: "A Model" }, { id: "b-model" }]);
  });

  test("{ models } gateway shape and bare arrays, strings included", () => {
    expect(normalizeRemoteModels({ models: ["m2", "m1"] })).toEqual([{ id: "m1" }, { id: "m2" }]);
    expect(normalizeRemoteModels([{ model: "x" }, "y"])).toEqual([{ id: "x" }, { id: "y" }]);
  });

  test("drops malformed rows, dedupes, ignores non-lists", () => {
    expect(
      normalizeRemoteModels({ data: [{ id: "m" }, { id: "m" }, { id: "" }, { no: "id" }, 42, null] }),
    ).toEqual([{ id: "m" }]);
    expect(normalizeRemoteModels({})).toEqual([]);
    expect(normalizeRemoteModels(undefined)).toEqual([]);
  });
});

describe("fetchRemoteModels", () => {
  test("calls {baseUrl}/models with Bearer + extra headers", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(() => jsonResponse({ data: [{ id: "m1" }] }), calls);
    const models = await fetchRemoteModels({
      baseUrl: "https://gw.example.com/v1/",
      apiKey: "sk-test",
      headers: { "X-Tenant": "acme" },
      fetch: fetchImpl,
    });
    expect(models).toEqual([{ id: "m1" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gw.example.com/v1/models");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer sk-test");
    expect(calls[0]?.headers["X-Tenant"]).toBe("acme");
  });

  test("no Authorization header without a key (keyless endpoints)", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(() => jsonResponse({ data: [] }), calls);
    await fetchRemoteModels({ baseUrl: "http://localhost:11434/v1", fetch: fetchImpl });
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/models");
    expect(calls[0]?.headers["Authorization"]).toBeUndefined();
  });

  test("non-2xx throws with the status and a body snippet", async () => {
    const fetchImpl = router(() => jsonResponse({ error: { message: "bad key", type: "auth" } }, 401), []);
    const err = await fetchRemoteModels({ baseUrl: "https://gw.example.com/v1", apiKey: "nope", fetch: fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("HTTP 401");
    expect((err as Error).message).toContain("bad key");
  });
});
