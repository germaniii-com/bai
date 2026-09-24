import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelInfo } from "@bai/shared";
import type { Provider } from "../src";
import { makeCore, type TestCore } from "./harness";

/** A registered provider with fixed models (agent runtime stream unused). */
function fakeProvider(name: string, models: ModelInfo[]): Provider {
  return {
    name: () => name,
    models: async () => models,
    stream: async () => {
      throw new Error("stream not used in models-page tests");
    },
  };
}

/**
 * Flat, offset-paged model catalog for UI pickers. Server-side slicing of the
 * merged providers view; agent model resolution is untouched.
 */
describe("Service.listModelsPage", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
  });

  test("pages a scoped provider; q and id filters; providerName attached", async () => {
    t.providers.register(
      fakeProvider("fake", [
        { id: "fake/one", provider: "fake", label: "One" },
        { id: "fake/two", provider: "fake", label: "Two" },
        { id: "fake/three", provider: "fake", label: "Three" },
      ]),
    );

    // Label-sorted (One, Three, Two) — the pickers' ordering.
    const first = await t.core.listModelsPage({ provider: "fake", limit: 2 });
    expect(first.models.map((m) => m.id)).toEqual(["fake/one", "fake/three"]);
    expect(first.models[0]?.providerName).toBe("fake");
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(2);
    expect(first.total).toBe(3);

    const second = await t.core.listModelsPage({ provider: "fake", limit: 2, offset: 2 });
    expect(second.models.map((m) => m.id)).toEqual(["fake/two"]);
    expect(second.hasMore).toBe(false);

    // q matches label.
    expect((await t.core.listModelsPage({ provider: "fake", q: "two" })).models.map((m) => m.id)).toEqual([
      "fake/two",
    ]);

    // Exact id lookup works without an explicit provider scope.
    expect((await t.core.listModelsPage({ id: "fake/three" })).models.map((m) => m.id)).toEqual(["fake/three"]);
    expect((await t.core.listModelsPage({ id: "fake/nope" })).models).toHaveLength(0);
  });

  test("flat list is scoped to connected providers; zdr floats capable models first", async () => {
    // "aaa" sorts before "openai" but is NOT ZDR-capable, so the two orders
    // differ only when preferZdr is on.
    t.providers.register(fakeProvider("aaa", [{ id: "aaa/m", provider: "aaa", label: "M" }]));
    t.providers.register(
      fakeProvider("openai", [{ id: "openai/gpt", provider: "openai", label: "GPT" }]),
    );
    // Neither is connected yet → the flat (unscoped) list is empty.
    expect((await t.core.listModelsPage({})).models).toHaveLength(0);

    t.accounts.set("aaa", "acc", { key: "k" });
    t.accounts.set("openai", "acc", { key: "k" });

    const plain = await t.core.listModelsPage({});
    expect(plain.models.map((m) => m.id)).toEqual(["aaa/m", "openai/gpt"]);

    const zdr = await t.core.listModelsPage({ zdr: true });
    expect(zdr.models.map((m) => m.id)).toEqual(["openai/gpt", "aaa/m"]);
  });

  test("hidden providers are excluded from the flat list, kept for explicit scope", async () => {
    t.providers.register(fakeProvider("aaa", [{ id: "aaa/m", provider: "aaa", label: "M" }]));
    t.providers.register(fakeProvider("openai", [{ id: "openai/gpt", provider: "openai", label: "GPT" }]));
    t.accounts.set("aaa", "acc", { key: "k" });
    t.accounts.set("openai", "acc", { key: "k" });

    // Hide aaa from the pickers (listing-only).
    t.config.providers = { aaa: { hidden: true } };
    expect((await t.core.listModelsPage({})).models.map((m) => m.id)).toEqual(["openai/gpt"]);
    // The wizard's per-provider step still resolves it.
    expect((await t.core.listModelsPage({ provider: "aaa" })).models.map((m) => m.id)).toEqual(["aaa/m"]);
    // An exact-id lookup still resolves too (a session already using it).
    expect((await t.core.listModelsPage({ id: "aaa/m" })).models.map((m) => m.id)).toEqual(["aaa/m"]);
  });
});
