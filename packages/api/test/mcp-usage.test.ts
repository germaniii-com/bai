import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

/**
 * GET /api/mcp/usage + /api/mcp/server/:name/usage — aggregation over seeded
 * mcp_events rows (the mcp-usage analog of usage.test.ts / skill.test.ts).
 */
describe("mcp usage analytics", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("aggregates recorded MCP interactions", async () => {
    stack.store.mcpUsage.insert({ server: "context7", tool: "search", ok: true, durationMs: 100, bytes: 100, now: "2026-09-08T10:00:00.000Z" });
    stack.store.mcpUsage.insert({ server: "context7", tool: "search", ok: true, durationMs: 300, bytes: 100, now: "2026-09-08T11:00:00.000Z" });
    stack.store.mcpUsage.insert({ server: "deepwiki", tool: "ask", ok: false, error: "boom", now: "2026-09-08T12:00:00.000Z" });

    const res = await app.request("/api/mcp/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kpis: { calls: number; errors: number; servers: number; avgDurationMs: number };
      byServer: { server: string; calls: number }[];
      series: { bucket: string; calls: number; errors: number }[];
    };
    expect(body.kpis.calls).toBe(3);
    expect(body.kpis.errors).toBe(1);
    expect(body.kpis.servers).toBe(2);
    expect(body.kpis.avgDurationMs).toBeCloseTo(133.33, 1);
    expect(body.byServer[0]?.server).toBe("context7");
    expect(body.byServer[0]?.calls).toBe(2);
    expect(body.series).toEqual([{ bucket: "2026-09-08", calls: 3, errors: 1 }]);
  });

  test("honors window + dimension filters", async () => {
    stack.store.mcpUsage.insert({ server: "a", tool: "x", ok: true, now: "2026-09-07T10:00:00.000Z" });
    stack.store.mcpUsage.insert({ server: "b", tool: "y", ok: true, now: "2026-09-08T10:00:00.000Z" });

    const windowed = await app.request("/api/mcp/usage?from=2026-09-08T00:00:00.000Z&to=2026-09-09T00:00:00.000Z");
    expect(windowed.status).toBe(200);
    expect(((await windowed.json()) as { kpis: { calls: number } }).kpis.calls).toBe(1);

    const byServer = await app.request("/api/mcp/usage?server=a");
    expect(((await byServer.json()) as { kpis: { calls: number } }).kpis.calls).toBe(1);

    const byKind = await app.request("/api/mcp/usage?kind=resource");
    expect(((await byKind.json()) as { kpis: { calls: number } }).kpis.calls).toBe(0);
  });

  test("per-server usage totals (never 404 — history outlives config)", async () => {
    stack.store.mcpUsage.insert({ server: "context7", tool: "search", ok: true, bytes: 100, now: "2026-09-08T10:00:00.000Z" });
    stack.store.mcpUsage.insert({ server: "context7", tool: "search", ok: false, error: "boom", now: "2026-09-08T11:00:00.000Z" });

    const res = await app.request("/api/mcp/server/context7/usage");
    expect(res.status).toBe(200);
    const totals = ((await res.json()) as {
      usage: { calls: number; errors: number; sessions: number; lastUsedAt?: string };
    }).usage;
    expect(totals).toEqual({
      calls: 2,
      errors: 1,
      sessions: 0,
      lastUsedAt: "2026-09-08T11:00:00.000Z",
    });

    const unknown = await app.request("/api/mcp/server/never/usage");
    expect(unknown.status).toBe(200);
    expect(((await unknown.json()) as { usage: { calls: number } }).usage.calls).toBe(0);
  });
});
