import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";
import type { UsageAnalyticsResponse } from "@bai/shared";

/**
 * GET /api/usage/analytics — aggregation over seeded usage rows. Dollars are
 * computed at FETCH time from each row's frozen rate snapshot, so the seeds
 * carry explicit rates and the asserts pin the exact math.
 */
describe("usage analytics api", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  /** Two models across two days with hand-checkable rate math. */
  function seed(): void {
    const ses = stack.store.sessions.insert({ workbench: "chat", now: "2026-03-01T00:00:00Z" });
    // Day 1, model A: 1M input @ $3/1M + 100k output @ $15/1M = 3 + 1.5 = $4.50
    stack.store.usage.insert({
      sessionId: ses.id,
      kind: "run",
      agent: "build",
      provider: "anthropic",
      account: "acct_1",
      model: "claude-sonnet-4-5",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
      now: "2026-03-01T10:00:00Z",
    });
    // Day 2, model B: 2M input @ $1/1M + 200k output @ $4/1M + 1M cache-read @ $0.1/1M
    //   = 2 + 0.8 + 0.1 = $2.90
    stack.store.usage.insert({
      sessionId: ses.id,
      kind: "run",
      agent: "build",
      provider: "openai",
      account: "env",
      model: "gpt-5.2",
      inputTokens: 2_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 1_000_000,
      rates: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0, cacheWrite1h: 0 },
      now: "2026-03-02T10:00:00Z",
    });
    // Background call (title) — same window, different kind.
    stack.store.usage.insert({
      sessionId: ses.id,
      kind: "title",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 7,
      outputTokens: 3,
      rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
      now: "2026-03-02T11:00:00Z",
    });
    // Failed call (provider 400) — zero tokens, error message recorded.
    stack.store.usage.insert({
      sessionId: ses.id,
      kind: "run",
      agent: "build",
      provider: "openrouter",
      model: "mistralai/mistral-nemo",
      error: "400 Provider returned error",
      rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
      now: "2026-03-02T12:00:00Z",
    });
  }

  test("KPIs, per-model totals, and series aggregate with fetch-time cost math", async () => {
    seed();
    const res = await app.request("/api/usage/analytics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageAnalyticsResponse;

    // KPIs: spend = 4.50 + 2.90 + (7×1 + 3×2)/1e6 = 7.400013 (error rows add 0)
    expect(body.kpis.requests).toBe(4);
    expect(body.kpis.spendUsd).toBeCloseTo(7.400013, 6);
    // tokens = (1M + 100k) + (2M + 200k + 1M) + 10 + 0 = 4_300_010
    expect(body.kpis.totalTokens).toBe(4_300_010);
    // cache hit rate = 1M cache-read ÷ (3M input + 1M read + 0 write) = 0.25
    expect(body.kpis.cacheHitRate).toBeCloseTo(0.25, 6);
    expect(body.kpis.blendedUsdPer1m).toBeCloseTo((7.400013 / 4_300_010) * 1_000_000, 6);

    // byModel sorted by spend desc: A ($4.50) → B ($2.90) → haiku ($0.000013)
    // → the failing model ($0, 1 error).
    expect(body.byModel.map((m) => m.model)).toEqual([
      "claude-sonnet-4-5",
      "gpt-5.2",
      "claude-haiku-4-5",
      "mistralai/mistral-nemo",
    ]);
    expect(body.byModel[0]?.spendUsd).toBeCloseTo(4.5, 6);
    expect(body.byModel[1]?.spendUsd).toBeCloseTo(2.9, 6);
    expect(body.byModel[1]?.cacheReadTokens).toBe(1_000_000);
    expect(body.byModel[3]?.errors).toBe(1);
    expect(body.byModel[3]?.spendUsd).toBe(0);

    // Daily series: two buckets, one model entry each (day 2 has three rows
    // of different models → three segments).
    expect(body.usageByModelSeries.map((b) => b.bucket)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(body.usageByModelSeries[0]?.byModel).toHaveLength(1);
    expect(body.usageByModelSeries[1]?.byModel).toHaveLength(3);
    expect(body.usageByModelSeries[0]?.byModel[0]?.spendUsd).toBeCloseTo(4.5, 6);

    // Request volume mirrors the same bucketing.
    expect(body.requestVolume[0]?.byModel[0]?.requests).toBe(1);
    expect(body.requestVolume[1]?.byModel.reduce((n, m) => n + m.requests, 0)).toBe(3);

    // Error series: day 1 clean; day 2 has 1 failure out of 3 calls.
    expect(body.errorSeries.map((b) => b.bucket)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(body.errorSeries[0]).toEqual({ bucket: "2026-03-01", requests: 1, errors: 0 });
    expect(body.errorSeries[1]).toEqual({ bucket: "2026-03-02", requests: 3, errors: 1 });

    // Token breakdown: day 1 prompt = 1M input; completion = output − reasoning.
    expect(body.tokenBreakdown[0]?.prompt).toBe(1_000_000);
    expect(body.tokenBreakdown[0]?.completion).toBe(100_000);
    // Cache series: day 2 cached = 1M read; uncached = 2M input + the title
    // row's 7 uncached prompt tokens.
    expect(body.cacheSeries[1]?.cached).toBe(1_000_000);
    expect(body.cacheSeries[1]?.uncached).toBe(2_000_007);
  });

  test("month granularity buckets by YYYY-MM", async () => {
    seed();
    const res = await app.request("/api/usage/analytics?granularity=month");
    const body = (await res.json()) as UsageAnalyticsResponse;
    expect(body.usageByModelSeries.map((b) => b.bucket)).toEqual(["2026-03"]);
    expect(body.tokenBreakdown).toHaveLength(1);
  });

  test("dimension + kind filters narrow the window", async () => {
    seed();
    const byAgent = await app.request("/api/usage/analytics?agent=build");
    expect(((await byAgent.json()) as UsageAnalyticsResponse).kpis.requests).toBe(3);

    const byKind = await app.request("/api/usage/analytics?kind=title");
    const titleOnly = (await byKind.json()) as UsageAnalyticsResponse;
    expect(titleOnly.kpis.requests).toBe(1);
    expect(titleOnly.kpis.spendUsd).toBeCloseTo(13e-6, 9);
    expect(titleOnly.byModel[0]?.model).toBe("claude-haiku-4-5");

    const byProvider = await app.request("/api/usage/analytics?provider=openai");
    expect(((await byProvider.json()) as UsageAnalyticsResponse).kpis.requests).toBe(1);

    // from/to window (to is EXCLUSIVE): day 1 only.
    const windowed = await app.request("/api/usage/analytics?from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z");
    const dayOne = (await windowed.json()) as UsageAnalyticsResponse;
    expect(dayOne.kpis.requests).toBe(1);
    expect(dayOne.kpis.spendUsd).toBeCloseTo(4.5, 6);
  });

  test("facets list distinct dimension values (unfiltered)", async () => {
    seed();
    const res = await app.request("/api/usage/analytics?kind=title");
    const body = (await res.json()) as UsageAnalyticsResponse;
    expect(body.facets.kinds).toEqual(["run", "title"]);
    expect(body.facets.providers).toEqual(["anthropic", "openai", "openrouter"]);
    expect(body.facets.models).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
      "gpt-5.2",
      "mistralai/mistral-nemo",
    ]);
    expect(body.facets.agents).toEqual(["build"]);
  });

  test("invalid granularity is rejected (zod)", async () => {
    const res = await app.request("/api/usage/analytics?granularity=week");
    expect(res.status).toBe(400);
  });

  test("empty store yields zeroed KPIs and empty series", async () => {
    const res = await app.request("/api/usage/analytics");
    const body = (await res.json()) as UsageAnalyticsResponse;
    expect(body.kpis).toEqual({ spendUsd: 0, totalTokens: 0, requests: 0, cacheHitRate: 0, blendedUsdPer1m: 0 });
    expect(body.byModel).toEqual([]);
    expect(body.usageByModelSeries).toEqual([]);
  });
});
