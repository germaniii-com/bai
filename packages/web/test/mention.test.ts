import { describe, expect, test } from "bun:test";
import { applyMention, mentionTrigger, splitMentionQuery } from "@bai/shared";

/**
 * The web composer's insertion flow, exercised through the shared grammar:
 * derive the trigger at the input's cursor, then replace it with the picked
 * entry (range preserved for files, drill-in for directories).
 */
function pick(
  draft: string,
  cursor: number,
  entry: { path: string; type: "file" | "dir" },
): { text: string; cursor: number } {
  const trigger = mentionTrigger(draft, cursor);
  if (trigger === null) return { text: draft, cursor };
  const range = entry.type === "file" ? splitMentionQuery(trigger.raw).range : undefined;
  return applyMention(draft, cursor, trigger, entry, range);
}

describe("web mention insertion", () => {
  test("inserts a whole-file mention with a trailing space", () => {
    expect(pick("see #src", 8, { path: "src/index.ts", type: "file" })).toEqual({
      text: "see #src/index.ts ",
      cursor: 18,
    });
  });

  test("preserves a typed line range", () => {
    expect(pick("#foo:10-20", 10, { path: "src/foo.ts", type: "file" })).toEqual({
      text: "#src/foo.ts:10-20 ",
      cursor: 18,
    });
  });

  test("directories drill in without a trailing space", () => {
    expect(pick("#sr", 3, { path: "src", type: "dir" })).toEqual({ text: "#src/", cursor: 5 });
  });

  test("leaves the draft alone when the cursor is outside a token", () => {
    expect(pick("plain text", 5, { path: "src/a.ts", type: "file" })).toEqual({
      text: "plain text",
      cursor: 5,
    });
  });
});
