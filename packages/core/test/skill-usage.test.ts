import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store";
import type { SessionId } from "@bai/shared";

/** The skill_events store (migration 006): insert, aggregate, per-skill totals. */
describe("SkillUsageRepo", () => {
  test("migration 006 creates the table; insert + list round-trip", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "bai-skill-usage-")), "test.db"));
    try {
      const session = store.sessions.insert({ workbench: "chat", now: "2026-09-08T10:00:00.000Z" });
      const row = store.skillUsage.insert({
        sessionId: session.id,
        skill: "arxiv",
        agent: "chat",
        ok: true,
        bytes: 1234,
        now: "2026-09-08T10:00:00.000Z",
      });
      expect(row.skill).toBe("arxiv");
      expect(row.agent).toBe("chat");
      expect(row.ok).toBe(true);
      expect(row.bytes).toBe(1234);
      expect(row.createdAt).toBe("2026-09-08T10:00:00.000Z");
      expect(row.id.startsWith("skl_")).toBe(true);

      const failure = store.skillUsage.insert({
        skill: "ghost",
        ok: false,
        error: "Unknown skill: ghost",
        now: "2026-09-08T11:00:00.000Z",
      });
      expect(failure.ok).toBe(false);
      expect(failure.error).toBe("Unknown skill: ghost");
      expect(failure.bytes).toBe(0);

      expect(store.skillUsage.list()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("analytics aggregates KPIs, per-skill totals, and the bucket series", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "bai-skill-usage-")), "test.db"));
    try {
      const sesA = store.sessions.insert({ workbench: "chat", now: "2026-09-07T10:00:00.000Z" });
      const sesB = store.sessions.insert({ workbench: "code", now: "2026-09-08T10:00:00.000Z" });
      const rows: Parameters<typeof store.skillUsage.insert>[0][] = [
        { sessionId: sesA.id, skill: "arxiv", agent: "chat", ok: true, bytes: 100, now: "2026-09-07T10:00:00.000Z" },
        { sessionId: sesA.id, skill: "arxiv", agent: "chat", ok: true, bytes: 100, now: "2026-09-08T10:00:00.000Z" },
        { sessionId: sesB.id, skill: "arxiv", agent: "build", ok: true, bytes: 100, now: "2026-09-08T11:00:00.000Z" },
        { sessionId: sesB.id, skill: "deploy", agent: "build", ok: true, bytes: 50, now: "2026-09-08T12:00:00.000Z" },
        { sessionId: sesB.id, skill: "ghost", agent: "build", ok: false, error: "Unknown skill: ghost", now: "2026-09-08T13:00:00.000Z" },
      ];
      for (const row of rows) store.skillUsage.insert(row);

      const all = store.skillUsage.analytics({});
      expect(all.kpis.views).toBe(5);
      expect(all.kpis.errors).toBe(1);
      expect(all.kpis.sessions).toBe(2);
      // Sorted by views desc; arxiv (3 views, 2 sessions) leads.
      expect(all.bySkill[0]?.skill).toBe("arxiv");
      expect(all.bySkill[0]?.views).toBe(3);
      expect(all.bySkill[0]?.sessions).toBe(2);
      expect(all.bySkill[0]?.lastUsedAt).toBe("2026-09-08T11:00:00.000Z");
      expect(all.bySkill[1]?.skill).toBe("deploy");
      // One bucket per day.
      expect(all.series).toEqual([
        { bucket: "2026-09-07", views: 1 },
        { bucket: "2026-09-08", views: 4 },
      ]);

      // Window filter: `from` inclusive, `to` exclusive.
      const day8 = store.skillUsage.analytics({ from: "2026-09-08T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z" });
      expect(day8.kpis.views).toBe(4);
      expect(day8.series).toEqual([{ bucket: "2026-09-08", views: 4 }]);

      // Month bucketing rides the 7-char RFC3339 prefix.
      const monthly = store.skillUsage.analytics({ granularity: "month" });
      expect(monthly.series).toEqual([{ bucket: "2026-09", views: 5 }]);
    } finally {
      store.close();
    }
  });

  test("forSkill counts successful views only, with distinct sessions", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "bai-skill-usage-")), "test.db"));
    try {
      const sesA = store.sessions.insert({ workbench: "chat", now: "2026-09-08T10:00:00.000Z" });
      const sesB = store.sessions.insert({ workbench: "chat", now: "2026-09-08T10:00:00.000Z" });
      store.skillUsage.insert({ sessionId: sesA.id, skill: "arxiv", ok: true, bytes: 10, now: "2026-09-08T10:00:00.000Z" });
      store.skillUsage.insert({ sessionId: sesB.id, skill: "arxiv", ok: true, bytes: 10, now: "2026-09-08T11:00:00.000Z" });
      store.skillUsage.insert({ sessionId: sesB.id, skill: "arxiv", ok: false, error: "bad path", now: "2026-09-08T12:00:00.000Z" });

      const totals = store.skillUsage.forSkill("arxiv");
      expect(totals.views).toBe(2);
      expect(totals.sessions).toBe(2);
      expect(totals.lastUsedAt).toBe("2026-09-08T11:00:00.000Z");

      const empty = store.skillUsage.forSkill("never");
      expect(empty.views).toBe(0);
      expect(empty.sessions).toBe(0);
      expect(empty.lastUsedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
