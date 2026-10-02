import { describe, expect, test } from "bun:test";
import type { ProviderInfo } from "@bai/shared";
import { videoSpecSchema } from "@bai/shared";
import {
  headerRowsFrom,
  headersFromRows,
  mergeModelSelection,
  modelOverrideOptions,
  modelSelectionRows,
  partitionProviders,
  slugifyProviderId,
  sortProviders,
  stripProviderPrefix,
  toggleModelSelection,
  videoStarter,
} from "../src/provider-utils";

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

describe("modelOverrideOptions", () => {
  function withModel(id: string, hidden = false): ProviderInfo {
    return { ...provider(id, true), hidden, models: [{ id: `${id}/m`, provider: id, label: "M" }] };
  }

  test("lists connected providers' models and excludes hidden providers", () => {
    const list = { providers: [withModel("openai"), withModel("aaa", true)], default: {} };
    const values = modelOverrideOptions(list).map((o) => o.value);
    expect(values).toEqual(["", "openai/m"]);
    expect(values).not.toContain("aaa/m");
  });

  test("null list returns only the inherit option", () => {
    expect(modelOverrideOptions(null)).toEqual([
      { value: "", label: "(agent/session model)", hint: "no override — inherit" },
    ]);
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

describe("header row helpers", () => {
  test("headersFromRows trims, skips blank keys, later keys win", () => {
    expect(
      headersFromRows([
        { key: " X-Tenant ", value: " acme " },
        { key: "  ", value: "dropped" },
        { key: "X-Tenant", value: "other" },
      ]),
    ).toEqual({ "X-Tenant": "other" });
    expect(headersFromRows([])).toBeUndefined();
    expect(headersFromRows([{ key: "", value: "" }])).toBeUndefined();
  });

  test("headerRowsFrom round-trips a header map", () => {
    expect(headerRowsFrom({ a: "1", b: "2" })).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
    expect(headerRowsFrom(undefined)).toEqual([]);
    expect(headersFromRows(headerRowsFrom({ a: "1" }))).toEqual({ a: "1" });
  });
});

describe("videoStarter", () => {
  test("the provider-file video block starter validates against videoSpecSchema", () => {
    const parsed = videoSpecSchema.safeParse(JSON.parse(videoStarter()));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.template).toBe("generic");
    expect(parsed.data.defaultModel).toBe("my-video-model");
    expect(parsed.data.models[0]?.workflows).toEqual(["t2v"]);
    // The response mapping must name base64 and/or url.
    expect(parsed.data.response.url).toBe("url");
  });

  test("is pretty-printed JSON with interpolated body tokens", () => {
    const raw = videoStarter();
    expect(raw.includes("\n  ")).toBe(true);
    const doc = JSON.parse(raw) as { generate: { body: Record<string, string> } };
    expect(doc.generate.body).toEqual({ prompt: "$prompt", model: "$model" });
  });
});

describe("slugifyProviderId", () => {
  test("derives a lowercase slug from the display name", () => {
    expect(slugifyProviderId("My Gateway")).toBe("my-gateway");
    expect(slugifyProviderId("  ACME  Cloud v2! ")).toBe("acme-cloud-v2");
    expect(slugifyProviderId("Ollama")).toBe("ollama");
  });

  test("empty when nothing is slug-worthy", () => {
    expect(slugifyProviderId("")).toBe("");
    expect(slugifyProviderId("!!!")).toBe("");
  });
});

describe("custom-provider fetched-model selection", () => {
  test("stripProviderPrefix removes the provider/ prefix only", () => {
    expect(stripProviderPrefix("gw", "gw/m1")).toBe("m1");
    expect(stripProviderPrefix("gw", "other/m1")).toBe("other/m1");
    expect(stripProviderPrefix("gw", "m1")).toBe("m1");
  });

  test("toggleModelSelection adds/removes without dupes", () => {
    expect(toggleModelSelection([], "a", true)).toEqual(["a"]);
    expect(toggleModelSelection(["a"], "a", true)).toEqual(["a"]);
    expect(toggleModelSelection(["a", "b"], "a", false)).toEqual(["b"]);
    expect(toggleModelSelection(["a"], "z", false)).toEqual(["a"]);
  });

  test("mergeModelSelection pre-selects every fetched id, keeps earlier picks", () => {
    expect(mergeModelSelection(["old"], [{ id: "b" }, { id: "a" }])).toEqual(["old", "b", "a"]);
    expect(mergeModelSelection(["a"], [{ id: "a" }])).toEqual(["a"]);
  });

  test("modelSelectionRows keeps selected ids the endpoint didn't return", () => {
    const rows = modelSelectionRows([{ id: "a", name: "A" }], ["a", "gone"]);
    expect(rows).toEqual([{ id: "a", name: "A" }, { id: "gone" }]);
  });
});
