import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store";

/** The media_events store (migration 010): insert, aggregate, filter, bucket. */
describe("MediaUsageRepo", () => {
  function makeStore(): Store {
    return new Store(join(mkdtempSync(join(tmpdir(), "bai-media-usage-")), "test.db"));
  }

  test("migration 010 creates the table; insert + list round-trip", () => {
    const store = makeStore();
    try {
      const row = store.mediaUsage.insert({
        provider: "openrouter",
        account: "personal",
        model: "google/gemini-3-pro-image",
        mode: "t2i",
        images: 2,
        costUsd: 0.08,
        durationMs: 1500,
        ok: true,
        now: "2026-09-15T10:00:00.000Z",
      });
      expect(row.provider).toBe("openrouter");
      expect(row.account).toBe("personal");
      expect(row.mode).toBe("t2i");
      expect(row.images).toBe(2);
      expect(row.costUsd).toBe(0.08);
      expect(row.ok).toBe(true);
      expect(store.mediaUsage.list()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("analytics aggregates KPIs, per-model, per-workflow, and the series", () => {
    const store = makeStore();
    try {
      store.mediaUsage.insert({ provider: "openrouter", model: "a", mode: "t2i", images: 2, costUsd: 0.10, durationMs: 1000, now: "2026-09-15T10:00:00.000Z" });
      store.mediaUsage.insert({ provider: "openrouter", model: "a", mode: "i2i", images: 1, costUsd: 0.05, durationMs: 2000, now: "2026-09-15T11:00:00.000Z" });
      store.mediaUsage.insert({ provider: "openrouter", model: "b", mode: "t2i", ok: false, error: "boom", durationMs: 500, now: "2026-09-16T09:00:00.000Z" });

      const res = store.mediaUsage.analytics({});
      expect(res.kpis.requests).toBe(3);
      expect(res.kpis.images).toBe(3);
      expect(res.kpis.spendUsd).toBeCloseTo(0.15);
      expect(res.kpis.errors).toBe(1);
      expect(res.kpis.avgCostPerImage).toBeCloseTo(0.05);
      expect(res.kpis.avgDurationMs).toBeCloseTo((1000 + 2000 + 500) / 3);

      expect(res.byModel[0]).toMatchObject({ model: "a", requests: 2, images: 3, errors: 0 });
      expect(res.byModel.find((m) => m.model === "b")).toMatchObject({ requests: 1, images: 0, errors: 1 });

      const t2i = res.byWorkflow.find((w) => w.mode === "t2i");
      const i2i = res.byWorkflow.find((w) => w.mode === "i2i");
      expect(t2i).toMatchObject({ requests: 2, images: 2 });
      expect(i2i).toMatchObject({ requests: 1, images: 1 });

      expect(res.series.map((s) => s.bucket)).toEqual(["2026-09-15", "2026-09-16"]);
      expect(res.series[0]).toMatchObject({ images: 3, requests: 2 });
      expect(res.series[0]?.spendUsd).toBeCloseTo(0.15);
      expect(res.series[1]).toMatchObject({ requests: 1, errors: 1 });
    } finally {
      store.close();
    }
  });

  test("honors window + dimension filters and granularity", () => {
    const store = makeStore();
    try {
      store.mediaUsage.insert({ provider: "openrouter", account: "a", model: "m1", mode: "t2i", images: 1, now: "2026-09-15T10:00:00.000Z" });
      store.mediaUsage.insert({ provider: "stub", account: "b", model: "m2", mode: "i2i", images: 1, now: "2026-10-02T10:00:00.000Z" });

      expect(store.mediaUsage.analytics({ provider: "stub" }).kpis.requests).toBe(1);
      expect(store.mediaUsage.analytics({ model: "m1" }).kpis.requests).toBe(1);
      expect(store.mediaUsage.analytics({ account: "b" }).kpis.requests).toBe(1);
      expect(store.mediaUsage.analytics({ mode: "i2i" }).kpis.requests).toBe(1);
      expect(
        store.mediaUsage.analytics({
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-09-30T00:00:00.000Z",
        }).kpis.requests,
      ).toBe(1);

      const monthly = store.mediaUsage.analytics({ granularity: "month" });
      expect(monthly.series.map((s) => s.bucket)).toEqual(["2026-09", "2026-10"]);
    } finally {
      store.close();
    }
  });

  test("empty store returns zeroed analytics", () => {
    const store = makeStore();
    try {
      const res = store.mediaUsage.analytics({});
      expect(res.kpis).toMatchObject({ requests: 0, images: 0, spendUsd: 0, errors: 0, avgCostPerImage: 0 });
      expect(res.byModel).toEqual([]);
      expect(res.byWorkflow).toEqual([]);
      expect(res.series).toEqual([]);
    } finally {
      store.close();
    }
  });
});
