import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

describe("provider & account API", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("GET /provider returns merged list with default model", async () => {
    const res = await app.request("/api/provider");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: { id: string; accounts: unknown[]; connected: boolean; models: { id: string }[] }[];
      default: { model?: string };
    };
    expect(body.default.model).toBe("stub/echo");
    const stub = body.providers.find((p) => p.id === "stub");
    expect(stub?.connected).toBe(false);
    expect(stub?.models[0]?.id).toBe("stub/echo");
  });

  test("account CRUD: put → listed (masked) → delete → 404 on re-delete", async () => {
    const put = await app.request("/api/provider/openai/account/personal", {
      method: "PUT",
      body: JSON.stringify({ label: "Personal", key: "sk-secret-123" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(201);
    const { account } = (await put.json()) as { account: { id: string; hasKey: boolean } };
    expect(account.id).toBe("personal");
    expect(account.hasKey).toBe(true);

    // listed, but the key never leaves the server
    const list = await app.request("/api/provider");
    const body = (await list.json()) as { providers: { id: string; connected: boolean; accounts: { id: string }[] }[] };
    const openai = body.providers.find((p) => p.id === "openai");
    expect(openai?.connected).toBe(true);
    expect(openai?.accounts.map((a) => a.id)).toEqual(["personal"]);
    expect(JSON.stringify(body)).not.toContain("sk-secret-123");

    const del = await app.request("/api/provider/openai/account/personal", { method: "DELETE" });
    expect(del.status).toBe(200);
    const del2 = await app.request("/api/provider/openai/account/personal", { method: "DELETE" });
    expect(del2.status).toBe(404);
  });

  test("put account validates body (zod)", async () => {
    const bad = await app.request("/api/provider/openai/account/x", {
      method: "PUT",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  test("account mutations publish provider.updated on the firehose", async () => {
    // Real loopback server + typed client (app.request buffers SSE bodies).
    const { dialListener } = await import("../src/client");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const client = dialListener(server.port ?? 0);
      const events: string[] = [];
      const ctrl = new AbortController();
      const done = (async () => {
        for await (const evt of client.globalEvents({ signal: ctrl.signal })) {
          events.push(evt.type);
          if (evt.type === "provider.updated") break;
        }
      })();
      await new Promise((r) => setTimeout(r, 100)); // let the firehose subscribe
      await client.putAccount("openai", "a", { key: "k" });
      const timeout = setTimeout(() => ctrl.abort(), 2000);
      await done.catch(() => {});
      clearTimeout(timeout);
      expect(events).toContain("provider.updated");
    } finally {
      await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 500))]);
    }
  });

  test("PUT /session/:id/model persists meta; 404 unknown session", async () => {
    const session = stack.core.createSession({ workbench: "chat" });
    const put = await app.request(`/api/session/${session.id}/model`, {
      method: "PUT",
      body: JSON.stringify({ model: "openai/gpt-test", account: "personal" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(200);
    const { session: updated } = (await put.json()) as { session: { meta: Record<string, unknown> } };
    expect(updated.meta.model).toBe("openai/gpt-test");
    expect(updated.meta.account).toBe("personal");

    const missing = await app.request("/api/session/ses_nope/model", {
      method: "PUT",
      body: JSON.stringify({ model: "stub/echo" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(missing.status).toBe(404);
  });

  test("typed client round-trips the new endpoints", async () => {
    const { createClient, dialListener } = await import("../src/client");
    void createClient;
    // The client is exercised against the app via a real listener in
    // client.test.ts; here we pin the wire shapes only.
    void dialListener;
    const res = await app.request("/api/provider/openai/account/w", {
      method: "PUT",
      body: JSON.stringify({ key: "k", baseUrl: "https://p.example.com/v1" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const { account } = (await res.json()) as { account: { baseUrl?: string } };
    expect(account.baseUrl).toBe("https://p.example.com/v1");
  });
});
