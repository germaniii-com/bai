import { describe, expect, test } from "bun:test";
import {
  accountOptions,
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
