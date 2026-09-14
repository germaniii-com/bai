import { describe, expect, test } from "bun:test";
import type { ProviderInfo } from "@bai/shared";
import { partitionProviders, sortProviders } from "../src/provider-utils";

function provider(id: string, connected = false, source: ProviderInfo["source"] = "catalog"): ProviderInfo {
  return {
    id,
    name: id,
    adapter: "openai-compatible",
    source,
    models: [],
    accounts: connected ? [{ provider: id, id: "a", label: "a", source: "api", hasKey: true }] : [],
    connected,
  };
}

describe("sortProviders", () => {
  test("connected first (stable), stub last, then alphabetical", () => {
    const sorted = sortProviders([
      provider("zeta"),
      provider("stub", true),
      provider("alpha", true),
      provider("beta", true),
      provider("mid"),
      provider("stub"),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["alpha", "beta", "stub", "mid", "zeta", "stub"]);
  });

  test("alphabetical within the connected group", () => {
    const sorted = sortProviders([provider("b", true), provider("a", true)]);
    expect(sorted.map((p) => p.id)).toEqual(["a", "b"]);
  });

  test("returns a copy, never the input", () => {
    const input = [provider("a")];
    expect(sortProviders(input)).not.toBe(input);
  });
});

describe("partitionProviders", () => {
  test("splits custom / oauth / catalog", () => {
    const providers = [
      provider("custom-a", false, "config"),
      provider("anthropic"),
      provider("openai-codex"),
      provider("groq"),
    ];
    const { custom, oauth, catalog } = partitionProviders(providers, ["anthropic", "openai-codex"]);
    expect(custom.map((p) => p.id)).toEqual(["custom-a"]);
    expect(oauth.map((p) => p.id)).toEqual(["anthropic", "openai-codex"]);
    expect(catalog.map((p) => p.id)).toEqual(["groq"]);
  });

  test("a custom provider wins over an OAuth id collision (no duplication)", () => {
    const { custom, oauth, catalog } = partitionProviders([provider("anthropic", false, "config")], ["anthropic"]);
    expect(custom.map((p) => p.id)).toEqual(["anthropic"]);
    expect(oauth).toEqual([]);
    expect(catalog).toEqual([]);
  });

  test("the explicit custom flag wins even for a catalog source", () => {
    const { custom } = partitionProviders([{ ...provider("weird"), custom: true }], []);
    expect(custom.map((p) => p.id)).toEqual(["weird"]);
  });

  test("preserves caller order within each section", () => {
    const providers = [provider("b"), provider("a"), provider("c")];
    const { catalog } = partitionProviders(providers, []);
    expect(catalog.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });
});
