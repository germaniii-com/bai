import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, CatalogService, ModelRouter, ProviderRegistry } from "../src";
import { DEFAULT_CONFIG, type Config, type ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src";

/** A recording fake provider: captures the LlmRequest the router built. */
function fakeProvider(name: string, calls: LlmRequest[]): Provider {
  return {
    name: () => name,
    models: async (): Promise<ModelInfo[]> => [{ id: `${name}/fake`, provider: name, label: "Fake" }],
    stream: async (req: LlmRequest): Promise<ProviderStream> => {
      calls.push(req);
      const events: StreamEvent[] = [
        { type: "text_delta", delta: "hi" },
        { type: "done", stopReason: "end_turn" },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const evt of events) yield evt;
        },
        close: async () => {},
      };
    },
  };
}

function makeFixture(env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bai-router-"));
  const config: Config = { ...DEFAULT_CONFIG, models: { default: "fake/fake" } };
  const accounts = new AuthStore({ file: join(dir, "auth.json") });
  const catalog = new CatalogService({
    cachePath: join(dir, "models-cache.json"),
    config: () => config,
    offline: true,
  });
  const registry = new ProviderRegistry({ catalog, config: () => config, accounts, env });
  const calls: LlmRequest[] = [];
  registry.register(fakeProvider("fake", calls));
  return {
    router: new ModelRouter(registry),
    registry,
    calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("ModelRouter (SDK version of the router)", () => {
  test("resolve() splits provider/model, picks account, and forwards auth", async () => {
    const fx = makeFixture();
    fx.registry.setAccount("fake", "work", { key: "sk-work" });
    const target = await fx.router.resolve("fake/fake", "work");
    expect(target.providerId).toBe("fake");
    expect(target.model).toBe("fake");
    expect(target.account).toBe("work");
    expect(target.auth.apiKey).toBe("sk-work");
    fx.cleanup();
  });

  test("chat() streams through the resolved adapter with the vendor model id", async () => {
    const fx = makeFixture();
    const { target, stream } = await fx.router.chat("fake/fake", undefined, [
      { role: "user", content: "hello" },
    ]);
    const deltas: string[] = [];
    for await (const evt of stream) {
      if (evt.type === "text_delta") deltas.push(evt.delta);
    }
    expect(target.providerId).toBe("fake");
    expect(deltas).toEqual(["hi"]);
    // Adapter receives the vendor model id (provider prefix stripped).
    expect(fx.calls[0]?.model).toBe("fake");
    expect(fx.calls[0]?.messages).toEqual([{ role: "user", content: "hello" }]);
    fx.cleanup();
  });

  test("models() aggregates the registry catalog", async () => {
    const fx = makeFixture();
    const models = await fx.router.models();
    expect(models.some((m) => m.id === "fake/fake")).toBe(true);
    fx.cleanup();
  });
});
