import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { TodoItem } from "@bai/shared";
import { TodosDialog } from "../src/views/todos";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sample: TodoItem[] = [
  { content: "Explore the repo", status: "completed", priority: "high" },
  { content: "Write the plan", status: "in_progress", priority: "high" },
  { content: "Implement it", status: "pending", priority: "medium" },
  { content: "Dropped idea", status: "cancelled", priority: "low" },
];

describe("TodosDialog", () => {
  test("renders the counts and every item with its status glyph", async () => {
    let closed = false;
    const { lastFrame, stdin, unmount } = render(
      <TodosDialog todos={sample} onClose={() => (closed = true)} />,
    );
    await tick();
    const frame = lastFrame() ?? "";

    expect(frame).toContain("todos");
    expect(frame).toContain("1 completed · 1 in progress · 1 pending · 1 cancelled");
    expect(frame).toContain("Explore the repo");
    expect(frame).toContain("Write the plan");
    expect(frame).toContain("Implement it");
    // Status glyph vocabulary: done / in progress / pending / cancelled.
    expect(frame).toContain("✓");
    expect(frame).toContain("◐");
    expect(frame).toContain("○");
    expect(frame).toContain("✗");
    // High priority is called out.
    expect(frame).toContain("high");

    stdin.write("\x1b"); // esc closes
    await tick();
    unmount();
    expect(closed).toBe(true);
  });

  test("renders the empty state", async () => {
    const { lastFrame, unmount } = render(<TodosDialog todos={[]} onClose={() => {}} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("no todos yet");
  });
});
