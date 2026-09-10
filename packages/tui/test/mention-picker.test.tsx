import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { MentionPicker } from "../src/components/mention-picker";
import {
  emptyMentionUi,
  moveMention,
  openedMention,
  selectedMention,
  withMentionResults,
  type MentionEntry,
} from "../src/state/mention";

const entries: MentionEntry[] = [
  { path: "src", type: "dir" },
  { path: "src/index.ts", type: "file" },
  { path: "src/components/button.tsx", type: "file" },
];

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("mention state", () => {
  test("moveMention wraps and no-ops on an empty list", () => {
    const open = withMentionResults(openedMention("src", "src"), entries);
    expect(selectedMention(open)?.path).toBe("src");
    expect(selectedMention(moveMention(open, -1))?.path).toBe("src/components/button.tsx");
    expect(selectedMention(moveMention(open, 1))?.path).toBe("src/index.ts");
    expect(moveMention(emptyMentionUi(), 1).selected).toBe(0);
  });

  test("withMentionResults clamps a stale selection", () => {
    const open = { ...openedMention("src", "src"), selected: 9 };
    const next = withMentionResults(open, entries);
    expect(next.selected).toBe(2);
    expect(next.loading).toBe(false);
  });
});

describe("MentionPicker render", () => {
  test("lists entries, marks the active row, and shows dir slashes", async () => {
    const { lastFrame, unmount } = render(
      <MentionPicker results={entries} selected={1} loading={false} query="src" />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("index.ts");
    expect(frame).toContain("button.tsx");
    expect(frame).toContain("❯");
    expect(frame).toContain("/");
    expect(frame).toContain("enter/tab insert");
  });

  test("shows a searching state while loading with no results", async () => {
    const { lastFrame, unmount } = render(
      <MentionPicker results={[]} selected={0} loading={true} query="nope" />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("searching");
  });

  test("surfaces an error", async () => {
    const { lastFrame, unmount } = render(
      <MentionPicker results={[]} selected={0} loading={false} query="x" error="permission denied" />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("permission denied");
  });
});
