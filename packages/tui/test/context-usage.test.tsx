import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { SessionUsage } from "@bai/shared";
import { ContextUsageDialog } from "../src/views/context-usage";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const usage: SessionUsage = {
  inputTokens: 40_000,
  outputTokens: 5_200,
  contextWindow: 200_000,
  costUsd: 0.0123,
  breakdown: { system: 12_000, tools: 8_000, skills: 2_000, mcp: 4_000, subagents: 1_000, conversation: 18_000 },
};

/** The TUI Context Usage dialog — the composer hub tracker's per-category breakdown. */
describe("ContextUsageDialog", () => {
  test("renders the fullness header, per-category rows (incl. mcp), and cost", async () => {
    let closed = false;
    const { lastFrame, stdin, unmount } = render(
      <ContextUsageDialog usage={usage} onClose={() => (closed = true)} />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("context usage");
    expect(frame).toContain("23% full");
    expect(frame).toContain("45k/200k");
    // Every breakdown category renders, mcp among them.
    expect(frame).toContain("system prompt");
    expect(frame).toContain("tools");
    expect(frame).toContain("skills");
    expect(frame).toContain("mcp");
    expect(frame).toContain("subagents");
    expect(frame).toContain("conversation");
    expect(frame).toContain("$0.012");

    stdin.write("\x1b"); // esc closes
    await tick();
    unmount();
    expect(closed).toBe(true);
  });

  test("empty stance before the first model response", async () => {
    const { lastFrame, unmount } = render(<ContextUsageDialog usage={null} onClose={() => {}} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("context usage appears after the first model response");
  });
});
