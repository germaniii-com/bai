import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, CatalogService, ModelRouter, ProviderRegistry } from "@bai/provider";
import { DEFAULT_CONFIG, type Config, type ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "@bai/provider";
import type { JobQueue, Service, Store } from "@bai/core";
import { createRouterApp, createRouterRoutes, type RouterDeps } from "../src";
import { parseChatRequest } from "../src/openai";

/** A fake provider that streams a fixed scripted response. */
function fakeProvider(events: StreamEvent[], calls: LlmRequest[]): Provider {
  return {
    name: () => "fake",
    models: async (): Promise<ModelInfo[]> => [{ id: "fake/fake-model", provider: "fake", label: "Fake Model" }],
    stream: async (req: LlmRequest): Promise<ProviderStream> => {
      calls.push(req);
      return {
        async *[Symbol.asyncIterator]() {
          for (const evt of events) yield evt;
        },
        close: async () => {},
      };
    },
  };
}

interface Fixture {
  deps: RouterDeps;
  calls: LlmRequest[];
  dir: string;
  cleanup(): void;
}

function makeFixture(opts: { events?: StreamEvent[]; accountKey?: string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "bai-router-gw-"));
  const config: Config = { ...DEFAULT_CONFIG, models: { default: "fake/fake-model" } };
  const accounts = new AuthStore({ file: join(dir, "auth.json") });
  if (opts.accountKey !== undefined) accounts.set("fake", "work", { key: opts.accountKey });
  const catalog = new CatalogService({ cachePath: join(dir, "models-cache.json"), config: () => config, offline: true });
  const registry = new ProviderRegistry({ catalog, config: () => config, accounts });
  const calls: LlmRequest[] = [];
  registry.register(
    fakeProvider(
      opts.events ?? [
        { type: "text_delta", delta: "Hello " },
        { type: "text_delta", delta: "world" },
        { type: "usage", inputTokens: 3, outputTokens: 2 },
        { type: "done", stopReason: "end_turn" },
      ],
      calls,
    ),
  );

  // Image asset bytes for the images route.
  const assetPath = join(dir, "img.png");
  writeFileSync(assetPath, new Uint8Array([137, 80, 78, 71]));

  const core = {
    enqueueImageGeneration: (request: unknown) => ({ id: "job_test", input: request }),
  } as unknown as Service;
  const jobs = {
    waitFor: async () => ({ id: "job_test", status: "done" }),
  } as unknown as JobQueue;
  const store = {
    assets: {
      byJob: () => [{ id: "asset_test", kind: "image", mime: "image/png", path: assetPath, bytes: 4, meta: {}, createdAt: "2026-09-16T00:00:00Z" }],
    },
  } as unknown as Store;

  return {
    deps: { router: new ModelRouter(registry), core, jobs, store, version: "9.9.9", loopbackBind: true },
    calls,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("router gateway", () => {
  test("GET /v1/models lists bai provider/model ids", async () => {
    const fx = makeFixture();
    const res = await createRouterRoutes(fx.deps).request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string; owned_by: string }> };
    expect(body.object).toBe("list");
    expect(body.data.some((m) => m.id === "fake/fake-model")).toBe(true);
    fx.cleanup();
  });

  test("POST /v1/chat/completions (non-stream) returns a completion object", async () => {
    const fx = makeFixture();
    const res = await createRouterRoutes(fx.deps).request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake/fake-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; choices: Array<{ message: { content: string }; finish_reason: string }>; usage?: { total_tokens: number } };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("Hello world");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage?.total_tokens).toBe(5);
    expect(fx.calls[0]?.model).toBe("fake-model");
    fx.cleanup();
  });

  test("POST /v1/chat/completions streams SSE chunks ending in [DONE]", async () => {
    const fx = makeFixture();
    const res = await createRouterRoutes(fx.deps).request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake/fake-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("Hello ");
    expect(text).toContain("data: [DONE]");
    fx.cleanup();
  });

  test("x-bai-account selects the saved account credentials", async () => {
    const fx = makeFixture({ accountKey: "sk-work" });
    await createRouterRoutes(fx.deps).request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bai-account": "work" },
      body: JSON.stringify({ model: "fake/fake-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(fx.calls[0]?.auth?.apiKey).toBe("sk-work");
    fx.cleanup();
  });

  test("missing model → 400", async () => {
    const fx = makeFixture();
    const res = await createRouterRoutes(fx.deps).request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    fx.cleanup();
  });

  test("POST /v1/images/generations routes to the job queue and returns base64", async () => {
    const fx = makeFixture();
    const res = await createRouterRoutes(fx.deps).request("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bai-account": "work" },
      body: JSON.stringify({ model: "openai/gpt-image-1", prompt: "a red panda", n: 1, size: "1024x1024" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ b64_json: string }> };
    expect(body.data).toHaveLength(1);
    expect(Buffer.from(body.data[0]?.b64_json ?? "", "base64")).toEqual(Buffer.from([137, 80, 78, 71]));
    fx.cleanup();
  });

  test("GET /api/help serves HTML; openapi.json is a valid document", async () => {
    const fx = makeFixture();
    const help = await createRouterApp(fx.deps).request("/api/help");
    expect(help.status).toBe(200);
    expect(help.headers.get("content-type")).toContain("text/html");
    const html = await help.text();
    expect(html).toContain("/v1/chat/completions");
    expect(html).toContain("x-bai-account");

    const spec = await createRouterApp(fx.deps).request("/api/help/openapi.json");
    expect(spec.status).toBe(200);
    const doc = (await spec.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/v1/chat/completions");
    fx.cleanup();
  });
});

describe("router live gate (config router.enabled)", () => {
  test("disabled → /v1/* and /api/help 404; enabled → 200; toggles live", async () => {
    const fx = makeFixture();
    let enabled = false;
    fx.deps.enabled = () => enabled;
    const routes = createRouterRoutes(fx.deps);
    const app = createRouterApp(fx.deps);

    // Disabled: the gateway behaves as if uninstalled.
    const offModels = await routes.request("/v1/models");
    expect(offModels.status).toBe(404);
    expect(((await offModels.json()) as { error: { type: string } }).error.type).toBe("router_disabled");
    expect((await app.request("/api/help")).status).toBe(404);
    expect((await app.request("/api/help/openapi.json")).status).toBe(404);

    // Enabled: same app instance, no rebuild — live.
    enabled = true;
    expect((await routes.request("/v1/models")).status).toBe(200);
    expect((await app.request("/api/help")).status).toBe(200);
    expect((await app.request("/api/help/openapi.json")).status).toBe(200);

    // Back off: live again.
    enabled = false;
    expect((await routes.request("/v1/models")).status).toBe(404);
    fx.cleanup();
  });

  test("omitting `enabled` keeps the gateway always on", async () => {
    const fx = makeFixture();
    expect(fx.deps.enabled).toBeUndefined();
    expect((await createRouterRoutes(fx.deps).request("/v1/models")).status).toBe(200);
    fx.cleanup();
  });
});

describe("parseChatRequest", () => {
  test("binds tool results into a synthetic user message and maps tools", () => {
    const parsed = parseChatRequest({
      model: "fake/fake-model",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "fs.read", arguments: '{"path":"a"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "file body" },
      ],
      tools: [{ type: "function", function: { name: "fs.read", description: "read", parameters: { type: "object" } } }],
    });
    expect(parsed.tools?.[0]?.name).toBe("fs.read");
    expect(parsed.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", callId: "call_1", name: "fs.read", args: '{"path":"a"}' }],
    });
    expect(parsed.messages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", callId: "call_1", content: "file body" }],
    });
  });
});
