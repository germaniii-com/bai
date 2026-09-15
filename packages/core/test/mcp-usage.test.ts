import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@bai/shared";
import { Store } from "../src/store/store";

/** The mcp_events store (migration 008): insert, aggregate, per-server totals. */
describe("McpUsageRepo", () => {
  test("migration 008 creates the table; insert + list round-trip", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "bai-mcp-usage-")), "test.db"));
    try {
      const session = store.sessions.insert({ workbench: "chat", now: "2026-09-08T10:00:00.000Z" });
      const row = store.mcpUsage.insert({
        sessionId: session.id,
        server: "context7",
        tool: "resolve-library-id",
        kind: "tool",
        agent: "build",
        ok: true,
        durationMs: 42,
        bytes: 1234,
        argsDigest: "abcdef0123456789",
        now: "2026-09-08T10:00:00.000Z",
      });
      expect(row.server).toBe("context7");
      expect(row.tool).toBe("resolve-library-id");
      expect(row.kind).toBe("tool");
      expect(row.agent).toBe("build");
      expect(row.ok).toBe(true);
      expect(row.durationMs).toBe(42);
      expect(row.bytes).toBe(1234);
      expect(row.argsDigest).toBe("abcdef0123456789");
      expect(row.createdAt).toBe("2026-09-08T10:00:00.000Z");
      expect(row.id.startsWith("mcp_")).toBe(true);

      const failure = store.mcpUsage.insert({
        server: "context7",
        tool: "read_resource",
        kind: "resource",
        ok: false,
        error: "MCP server is not connected",
        now: "2026-09-08T11:00:00.000Z",
      });
      expect(failure.ok).toBe(false);
      expect(failure.error).toBe("MCP server is not connected");
      expect(failure.bytes).toBe(0);
      expect(failure.argsDigest).toBeUndefined();

      expect(store.mcpUsage.list()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("analytics aggregates KPIs, per-server/per-tool totals, and the series", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "bai-mcp-usage-")), "test.db"));
    try {
      const sesA = store.sessions.insert({ workbench: "chat", now: "2026-09-07T10:00:00.000Z" });
      const sesB = store.sessions.insert({ workbench: "code", now: "2026-09-08T10:00:00.000Z" });
      const rows: Parameters<typeof store.mcpUsage.insert>[0][] = [
        { sessionId: sesA.id, server: "context7", tool: "search", kind: "tool", agent: "build", ok: true, durationMs: 100, bytes: 100, now: "2026-09-07T10:00:00.000Z" },
        { sessionId: sesA.id, server: "context7", tool: "search", kind: "tool", agent: "build", ok: true, durationMs: 300, bytes: 200, now: "2026-09-08T10:00:00.000Z" },
        { sessionId: sesB.id, server: "deepwiki", tool: "ask", kind: "tool", agent: "chat", ok: true, durationMs: 200, bytes: 300, now: "2026-09-08T11:00:00.000Z" },
        { sessionId: sesB.id, server: "(all)", tool: "list_resources", kind: "resource", agent: "chat", ok: false, error: "not connected", now: "2026-09-08T12:00:00.000Z" },
      ];
      for (const row of rows) store.mcpUsage.insert(row);

      const all = store.mcpUsage.analytics({});
      expect(all.kpis.calls).toBe(4);
      expect(all.kpis.errors).toBe(1);
      expect(all.kpis.sessions).toBe(2);
      // "(all)" is a helper scope, not a real server.
      expect(all.kpis.servers).toBe(2);
      expect(all.kpis.totalBytes).toBe(600);
      expect(all.kpis.avgDurationMs).toBeCloseTo(150, 5);
      // Sorted by calls desc; context7 (2 calls) leads.
      expect(all.byServer[0]?.server).toBe("context7");
      expect(all.byServer[0]?.calls).toBe(2);
      expect(all.byServer[0]?.sessions).toBe(1);
      expect(all.byServer[0]?.lastUsedAt).toBe("2026-09-08T10:00:00.000Z");
      expect(all.byTool[0]?.tool).toBe("search");
      expect(all.byTool[0]?.calls).toBe(2);
      expect(all.byTool[0]?.avgDurationMs).toBeCloseTo(200, 5);
      // One bucket per day.
      expect(all.series).toEqual([
        { bucket: "2026-09-07", calls: 1, errors: 0 },
        { bucket: "2026-09-08", calls: 3, errors: 1 },
      ]);

      // Window filter: `from` inclusive, `to` exclusive.
      const day8 = store.mcpUsage.analytics({ from: "2026-09-08T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z" });
      expect(day8.kpis.calls).toBe(3);
      expect(day8.series).toEqual([{ bucket: "2026-09-08", calls: 3, errors: 1 }]);

      // Dimension filters.
      expect(store.mcpUsage.analytics({ server: "context7" }).kpis.calls).toBe(2);
      expect(store.mcpUsage.analytics({ agent: "chat" }).kpis.calls).toBe(2);
      expect(store.mcpUsage.analytics({ kind: "resource" }).kpis.calls).toBe(1);

      // Month bucketing rides the 7-char RFC3339 prefix.
      const monthly = store.mcpUsage.analytics({ granularity: "month" });
      expect(monthly.series).toEqual([{ bucket: "2026-09", calls: 4, errors: 1 }]);
    } finally {
      store.close();
    }
  });

  test("forServer counts calls, errors, and distinct sessions", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "bai-mcp-usage-")), "test.db"));
    try {
      const sesA = store.sessions.insert({ workbench: "chat", now: "2026-09-08T10:00:00.000Z" });
      const sesB = store.sessions.insert({ workbench: "chat", now: "2026-09-08T10:00:00.000Z" });
      store.mcpUsage.insert({ sessionId: sesA.id, server: "context7", tool: "search", ok: true, bytes: 10, now: "2026-09-08T10:00:00.000Z" });
      store.mcpUsage.insert({ sessionId: sesB.id, server: "context7", tool: "search", ok: true, bytes: 10, now: "2026-09-08T11:00:00.000Z" });
      store.mcpUsage.insert({ sessionId: sesB.id, server: "context7", tool: "search", ok: false, error: "boom", now: "2026-09-08T12:00:00.000Z" });

      const totals = store.mcpUsage.forServer("context7");
      expect(totals.calls).toBe(3);
      expect(totals.errors).toBe(1);
      expect(totals.sessions).toBe(2);
      expect(totals.lastUsedAt).toBe("2026-09-08T12:00:00.000Z");

      const empty = store.mcpUsage.forServer("never");
      expect(empty.calls).toBe(0);
      expect(empty.errors).toBe(0);
      expect(empty.sessions).toBe(0);
      expect(empty.lastUsedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("session attribution survives a null session id", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "bai-mcp-usage-")), "test.db"));
    try {
      const row = store.mcpUsage.insert({
        sessionId: undefined as unknown as SessionId,
        server: "echo",
        tool: "echo",
        now: "2026-09-08T10:00:00.000Z",
      });
      expect(row.sessionId).toBeUndefined();
      expect(row.kind).toBe("tool");
      expect(store.mcpUsage.analytics({}).kpis.sessions).toBe(0);
    } finally {
      store.close();
    }
  });
});
