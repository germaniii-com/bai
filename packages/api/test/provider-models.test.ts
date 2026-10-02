import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("POST /api/provider/models", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;
  let seenAuth: (string | undefined)[];

  beforeEach(() => {
    seenAuth = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seenAuth.push(headers["Authorization"]);
      if (String(url).includes("unauthorized")) {
        return jsonResponse({ error: { message: "bad key", type: "auth" } }, 401);
      }
      return jsonResponse({ data: [{ id: "b-model" }, { id: "a-model", name: "A Model" }] });
    }) as unknown as typeof globalThis.fetch;
    stack = makeStack({ fetch: fetchImpl });
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("proxies GET {baseUrl}/models with the request key", async () => {
    const res = await app.request("/api/provider/models", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "https://gw.example.com/v1", apiKey: "sk-test" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [{ id: "a-model", name: "A Model" }, { id: "b-model" }] });
    expect(seenAuth).toEqual(["Bearer sk-test"]);
  });

  test("falls back to the stored key for a known provider id", async () => {
    const create = await app.request("/api/provider/my-gw/custom", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://gw.example.com/v1", apiKey: "stored-key" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(create.status).toBe(200);

    const res = await app.request("/api/provider/models", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "https://gw.example.com/v1", provider: "my-gw" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(seenAuth).toEqual(["Bearer stored-key"]);
  });

  test("account scopes the stored-key lookup to that account", async () => {
    const create = await app.request("/api/provider/my-gw/custom", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://gw.example.com/v1" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(create.status).toBe(200);
    const account = await app.request("/api/provider/my-gw/account/main", {
      method: "PUT",
      body: JSON.stringify({ label: "Main", key: "account-key" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(account.status).toBe(201);

    const res = await app.request("/api/provider/models", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "https://gw.example.com/v1", provider: "my-gw", account: "main" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(seenAuth).toEqual(["Bearer account-key"]);
  });

  test("validates the body", async () => {
    const res = await app.request("/api/provider/models", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "not-a-url" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  test("upstream failure surfaces as 400 with the status", async () => {
    const res = await app.request("/api/provider/models", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "https://unauthorized.example.com/v1", apiKey: "nope" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("401");
  });
});
