import { describe, expect, test } from "bun:test";
import type { ProviderInfo } from "@bai/shared";
import { sortProviders } from "../src/provider-utils";

function provider(id: string, connected = false): ProviderInfo {
  return {
    id,
    name: id,
    adapter: "openai-compatible",
    source: "catalog",
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
