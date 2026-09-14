import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, dialListener } from "../src";
import { makeStack, type TestStack } from "./harness";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("OAuth login API", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("GET /provider/oauth lists login-capable providers", async () => {
    const res = await app.request("/api/provider/oauth");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: { id: string; method: string; connected: boolean }[] };
    const ids = body.providers.map((p) => p.id);
    expect(ids).toContain("fake-oauth");
    expect(ids).toContain("openai-codex");
    expect(body.providers.find((p) => p.id === "fake-oauth")?.method).toBe("device_code");
  });

  test("start → poll approved → account usable, tokens never echoed", async () => {
    const start = await app.request("/api/provider/fake-oauth/oauth/start", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(start.status).toBe(201);
    const started = (await start.json()) as { session: { id: string; status: string; userCode?: string } };
    expect(started.session.userCode).toBe("TEST-CODE");

    await tick();
    const poll = await app.request(`/api/provider/fake-oauth/oauth/sessions/${started.session.id}`);
    expect(poll.status).toBe(200);
    const polled = (await poll.json()) as { session: { status: string } };
    expect(polled.session.status).toBe("approved");

    const list = await app.request("/api/provider");
    const body = (await list.json()) as { providers: { id: string; accounts: { id: string; source: string; hasKey: boolean }[] }[] };
    const fake = body.providers.find((p) => p.id === "fake-oauth");
    expect(fake?.accounts[0]?.source).toBe("oauth");
    expect(fake?.accounts[0]?.hasKey).toBe(false);
    expect(JSON.stringify(body)).not.toContain("fake-access");
  });

  test("cancel returns ok", async () => {
    const start = await app.request("/api/provider/fake-oauth/oauth/start", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const { session } = (await start.json()) as { session: { id: string } };
    const cancel = await app.request(`/api/provider/fake-oauth/oauth/sessions/${session.id}`, { method: "DELETE" });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("unknown provider start → 400", async () => {
    const res = await app.request("/api/provider/not-real/oauth/start", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  test("typed client (the TUI/web path): oauthProviders + start + poll", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createApp(stack.deps).fetch });
    const client = dialListener(server.port ?? 0);
    try {
      const providers = await client.oauthProviders();
      expect(providers.map((p) => p.id)).toContain("fake-oauth");

      const session = await client.startOAuth("fake-oauth", { mode: "device" });
      expect(session.method).toBe("device_code");
      expect(session.userCode).toBe("TEST-CODE");

      await tick();
      const polled = await client.pollOAuth("fake-oauth", session.id);
      expect(polled.status).toBe("approved");
    } finally {
      await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 1000))]);
    }
  });
});

describe("custom provider API", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("PUT custom provider → listed with adapter/endpoint; DELETE removes it", async () => {
    const put = await app.request("/api/provider/my-gw/custom", {
      method: "PUT",
      body: JSON.stringify({
        name: "My Gateway",
        baseUrl: "https://gw.example.com/v1",
        adapter: "responses",
        apiKeyEnv: "MY_GW_KEY",
        models: ["m1"],
        headers: { "X-Tenant": "acme" },
        contextLength: 4096,
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(200);

    const list = await app.request("/api/provider");
    const body = (await list.json()) as { providers: { id: string; adapter: string; baseUrl?: string; models: { id: string }[] }[] };
    const gw = body.providers.find((p) => p.id === "my-gw");
    expect(gw?.adapter).toBe("responses");
    expect(gw?.baseUrl).toBe("https://gw.example.com/v1");
    expect(gw?.models.some((m) => m.id === "my-gw/m1")).toBe(true);

    const del = await app.request("/api/provider/my-gw/custom", { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await app.request("/api/provider");
    const body2 = (await after.json()) as { providers: { id: string }[] };
    expect(body2.providers.some((p) => p.id === "my-gw")).toBe(false);
  });

  test("PUT custom provider validates the body", async () => {
    const bad = await app.request("/api/provider/x/custom", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "not-a-url" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });
});
