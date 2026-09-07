import { describe, expect, test } from "bun:test";
import {
  accountOptions,
  allModelOptions,
  currentModelLabel,
  modelOptions,
  needsSetup,
  providerOptions,
  applyTarget,
} from "../src/state/providers";
import type { ProviderInfo, ProviderListResponse, Session } from "@bai/shared";

function provider(partial: Partial<ProviderInfo> & { id: string }): ProviderInfo {
  return {
    name: partial.id,
    adapter: "openai-compatible",
    source: "catalog",
    models: [],
    accounts: [],
    connected: false,
    ...partial,
  };
}

const LIST: ProviderListResponse = {
  providers: [
    provider({ id: "stub", connected: false }),
    provider({ id: "zeta", connected: true, accounts: [{ provider: "zeta", id: "main", label: "Main", source: "api", hasKey: true }] }),
    provider({ id: "alpha", connected: true, accounts: [{ provider: "alpha", id: "a", label: "A", source: "api", hasKey: true }] }),
    provider({ id: "mid", connected: false }),
  ],
  default: { model: "alpha/m1" },
};

describe("provider picker logic", () => {
  test("providerOptions: connected first, stub last, alphabetical within groups", () => {
    const opts = providerOptions(LIST.providers);
    expect(opts.map((o) => o.value)).toEqual(["alpha", "zeta", "mid", "stub"]);
    expect(opts[0]?.gutter).toBe("✓");
    expect(opts[2]?.gutter).toBeUndefined();
    expect(opts[0]?.hint).toContain("1 account");
  });

  test("accountOptions project label + source hints", () => {
    const p = provider({
      id: "openai",
      connected: true,
      accounts: [
        { provider: "openai", id: "personal", label: "Personal", source: "api", hasKey: true },
        { provider: "openai", id: "env", label: "env: OPENAI_API_KEY", source: "env", hasKey: true },
      ],
    });
    const opts = accountOptions(p);
    expect(opts.map((o) => o.value)).toEqual(["personal", "env"]);
    expect(opts[1]?.hint).toBe("from environment");
  });

  test("modelOptions sort by label and append the custom-id escape hatch", () => {
    const p = provider({
      id: "p",
      models: [
        { id: "p/z", provider: "p", label: "Zeta" },
        { id: "p/a", provider: "p", label: "Alpha", contextWindow: 200000, inputCost: 3 },
      ],
    });
    const opts = modelOptions(p);
    expect(opts.map((o) => o.value)).toEqual(["p/a", "p/z", "__custom__"]);
    expect(opts[0]?.hint).toContain("200k ctx");
    expect(opts[0]?.hint).toContain("$3/M in");
  });

  test("allModelOptions: flat list across connected providers, stub excluded", () => {
    const opts = allModelOptions(LIST.providers.concat(
      provider({
        id: "alpha",
        connected: true,
        models: [
          { id: "alpha/m2", provider: "alpha", label: "M2" },
          { id: "alpha/m1", provider: "alpha", label: "M1", contextWindow: 100000 },
        ],
      }),
      provider({
        id: "zeta",
        connected: true,
        models: [{ id: "zeta/m9", provider: "zeta", label: "M9", inputCost: 12 }],
      }),
    ));
    // alpha (connected, alphabetically first) then zeta; label-sorted within
    // each; provider name leads every hint; custom escape hatch last.
    expect(opts.map((o) => o.value)).toEqual([
      "alpha/m1",
      "alpha/m2",
      "zeta/m9",
      "__custom__",
    ]);
    expect(opts[0]?.hint).toBe("alpha · 100k ctx");
    expect(opts[2]?.hint).toBe("zeta · $12/M in");
    expect(opts[3]?.hint).toBe("provider/model");
  });

  test("allModelOptions: unconnected providers contribute nothing", () => {
    const opts = allModelOptions([
      provider({ id: "mid", connected: false, models: [{ id: "mid/x", provider: "mid", label: "X" }] }),
      provider({ id: "stub", connected: true, models: [{ id: "stub/echo", provider: "stub", label: "Echo" }] }),
    ]);
    expect(opts.map((o) => o.value)).toEqual(["__custom__"]);
  });

  test("modelOptions: preferZdr floats capable models first with a zdr hint", () => {
    const p = provider({
      id: "openai",
      models: [
        { id: "openai/z-model", provider: "openai", label: "Zeta model" },
        { id: "openai/a-model", provider: "openai", label: "Alpha model", contextWindow: 100000 },
      ],
    });
    // Off: plain label order, no zdr hint.
    const off = modelOptions(p);
    expect(off.map((o) => o.value)).toEqual(["openai/a-model", "openai/z-model", "__custom__"]);
    expect(off[0]?.hint).not.toContain("zdr");
    // On: capable models first (input order kept within groups) + hint badge.
    const on = modelOptions(p, true);
    expect(on.map((o) => o.value)).toEqual(["openai/a-model", "openai/z-model", "__custom__"]);
    expect(on[0]?.hint).toContain("zdr");
    expect(on[1]?.hint).toContain("zdr");
  });

  test("modelOptions: preferZdr keeps excluded models in the tail group", () => {
    const p = provider({
      id: "anthropic",
      models: [
        { id: "anthropic/claude-fable-5", provider: "anthropic", label: "Fable" },
        { id: "anthropic/claude-sonnet-4-5", provider: "anthropic", label: "Sonnet" },
      ],
    });
    const opts = modelOptions(p, true);
    expect(opts.map((o) => o.value)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-fable-5",
      "__custom__",
    ]);
    expect(opts[0]?.hint).toContain("zdr");
    expect(opts[1]?.hint ?? "").not.toContain("zdr");
  });

  test("allModelOptions: preferZdr floats capable models first across providers", () => {
    const opts = allModelOptions(
      [
        provider({
          id: "deepseek",
          connected: true,
          models: [{ id: "deepseek/v4", provider: "deepseek", label: "V4" }],
        }),
        provider({
          id: "openai",
          connected: true,
          models: [{ id: "openai/gpt-5", provider: "openai", label: "GPT-5" }],
        }),
      ],
      true,
    );
    expect(opts.map((o) => o.value)).toEqual(["openai/gpt-5", "deepseek/v4", "__custom__"]);
    expect(opts[0]?.hint).toContain("zdr");
    expect(opts[1]?.hint ?? "").not.toContain("zdr");
  });

  test("applyTarget: session when active, global otherwise", () => {
    const session = { id: "ses_x", meta: {} } as unknown as Session;
    expect(applyTarget(session)).toBe("session");
    expect(applyTarget(null)).toBe("global");
  });

  test("currentModelLabel: session override > default; account label resolved", () => {
    const session = {
      id: "ses_x",
      meta: { model: "alpha/m2", account: "a" },
    } as unknown as Session;
    expect(currentModelLabel(session, LIST)).toBe("alpha/m2 · A");
    expect(currentModelLabel(null, LIST)).toBe("alpha/m1");
    // mirrors the run path's fallback (config default → stub/echo)
    expect(currentModelLabel(null, null)).toBe("stub/echo");
  });

  test("currentModelLabel: config default keeps the header truthful without the list", () => {
    // On-demand provider list: before the first picker open the list is null, but
    // the config's default model (tiny GET /api/config) fills the header.
    expect(currentModelLabel(null, null, "zeta/m9")).toBe("zeta/m9");
    expect(currentModelLabel(null, null, undefined)).toBe("stub/echo");
    // Precedence: loaded list beats config default; session meta beats both.
    expect(currentModelLabel(null, LIST, "zeta/m9")).toBe("alpha/m1");
    expect(currentModelLabel(
      { id: "ses_x", meta: { model: "alpha/m2" } } as unknown as Session,
      null,
      "zeta/m9",
    )).toBe("alpha/m2"); // session meta wins; no account suffix without the list
  });

  test("needsSetup: true until a non-stub provider connects", () => {
    expect(needsSetup(LIST)).toBe(false);
    expect(
      needsSetup({
        providers: [provider({ id: "stub", connected: true })],
        default: {},
      }),
    ).toBe(true);
    expect(needsSetup(null)).toBe(false);
  });
});
