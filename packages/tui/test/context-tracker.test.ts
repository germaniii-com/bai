import { describe, expect, test } from "bun:test";
import { contextBreakdownRows, contextTokensUsed, contextTracker, formatCost, formatTokens } from "@bai/shared";
import type { SessionUsage } from "@bai/shared";

/**
 * The context tracker's pure math (shared/src/display.ts) — the same helper
 * renders the TUI hub's commands-row lead and the web composer's chip, so
 * both surfaces stay in lockstep (pi's thresholds, opencode's label).
 */
describe("formatTokens", () => {
  test("compact token formatting (pi's footer format)", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(9_999)).toBe("10.0k");
    expect(formatTokens(45_200)).toBe("45k");
    expect(formatTokens(999_999)).toBe("1000k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(12_000_000)).toBe("12M");
  });
});

describe("contextTracker", () => {
  test("undefined/null → nothing to show", () => {
    expect(contextTracker(undefined)).toBeUndefined();
    expect(contextTracker(null)).toBeUndefined();
    expect(contextTracker({})).toBeUndefined();
  });

  test("tokens + window → `45k/200k (23%)`", () => {
    const usage: SessionUsage = { inputTokens: 40_000, outputTokens: 5_200, contextWindow: 200_000 };
    expect(contextTracker(usage)).toEqual({ label: "45k/200k (23%)", tone: "dim" });
  });

  test("tokens without a window → no percentage", () => {
    expect(contextTracker({ inputTokens: 40_000, outputTokens: 5_200 })).toEqual({
      label: "45k",
      tone: "dim",
    });
  });

  test("reasoning tokens are NOT added (subset of output — no double count)", () => {
    const usage: SessionUsage = { inputTokens: 40_000, outputTokens: 5_200, reasoningTokens: 3_000, contextWindow: 200_000 };
    expect(contextTracker(usage)).toEqual({ label: "45k/200k (23%)", tone: "dim" });
  });

  test("cache tokens count toward context (they occupy the window)", () => {
    const usage: SessionUsage = { inputTokens: 1_000, cacheReadTokens: 40_000, cacheWriteTokens: 4_200, contextWindow: 200_000 };
    expect(contextTracker(usage)).toEqual({ label: "45k/200k (23%)", tone: "dim" });
  });

  test("thresholds: warning >70%, danger >90% of the window", () => {
    expect(contextTracker({ inputTokens: 150_000, contextWindow: 200_000 })?.tone).toBe("warning"); // 75%
    expect(contextTracker({ inputTokens: 185_000, contextWindow: 200_000 })?.tone).toBe("danger"); // 93%
    expect(contextTracker({ inputTokens: 140_000, contextWindow: 200_000 })?.tone).toBe("dim"); // 70%
  });

  test("post-compaction (token-less row with window) → `?/200k`", () => {
    expect(contextTracker({ contextWindow: 200_000 })).toEqual({ label: "?/200k", tone: "dim" });
  });

  test("token-less row without a window → nothing to show", () => {
    expect(contextTracker({ model: "stub/echo" })).toBeUndefined();
  });

  test("cumulative session cost rides along when present", () => {
    const usage: SessionUsage = { inputTokens: 40_000, outputTokens: 5_200, contextWindow: 200_000, costUsd: 0.0123 };
    expect(contextTracker(usage)).toEqual({ label: "45k/200k (23%)", tone: "dim", costLabel: "$0.012" });
  });

  test("zero cost adds no cost label", () => {
    const usage: SessionUsage = { inputTokens: 40_000, contextWindow: 200_000, costUsd: 0 };
    expect(contextTracker(usage)).toEqual({ label: "40k/200k (20%)", tone: "dim" });
  });
});

describe("formatCost", () => {
  test("compact USD with sub-cent precision", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(-1)).toBe("$0.00");
    expect(formatCost(Number.NaN)).toBe("$0.00");
    expect(formatCost(0.00042)).toBe("$0.0004");
    expect(formatCost(0.0123)).toBe("$0.012");
    expect(formatCost(0.5)).toBe("$0.500");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(123.4)).toBe("$123.40");
  });
});

describe("contextTokensUsed", () => {
  test("sums input + output + cache reads + cache writes, excluding reasoning", () => {
    expect(
      contextTokensUsed({
        inputTokens: 40_000,
        outputTokens: 5_200,
        reasoningTokens: 3_000,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 500,
      }),
    ).toBe(46_700);
  });
});

describe("contextBreakdownRows", () => {
  test("undefined/null → no rows", () => {
    expect(contextBreakdownRows(undefined)).toEqual([]);
    expect(contextBreakdownRows(null)).toEqual([]);
  });

  test("fixed category order + labels + token passthrough", () => {
    const rows = contextBreakdownRows({ system: 1, tools: 2, skills: 3, mcp: 4, subagents: 5, conversation: 6 });
    expect(rows.map((r) => r.key)).toEqual(["system", "tools", "skills", "mcp", "subagents", "conversation"]);
    expect(rows.map((r) => r.label)).toEqual([
      "system prompt",
      "tools",
      "skills",
      "mcp",
      "subagents",
      "conversation",
    ]);
    expect(rows.map((r) => r.tokens)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
