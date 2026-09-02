import { describe, expect, test } from "bun:test";
import wrapAnsi from "wrap-ansi";
import { __estimateRows, __wrappedRows } from "../src/views/chat";
import type { Message, MessageId, Part, PartId, SessionId } from "@bai/shared";

function part(ord: number, kind: Part["kind"], payload: unknown): Part {
  return { id: `part_${ord}` as PartId, messageId: "msg_1" as MessageId, ord, kind, payload };
}

function msg(role: Message["role"], parts: Part[]): Message {
  return { id: `msg_${Math.random()}` as MessageId, sessionId: "ses_1" as SessionId, role, createdAt: "t", parts };
}

describe("estimateRows (viewer height estimation)", () => {
  test("wrappedRows matches wrap-ansi's exact row count (word-wrapped prose)", () => {
    const width = 10;
    const samples = [
      "the quick brown fox jumps over the lazy dog",
      "Q6: Moon Knight real name — user answered — wrong, the real name is Marc",
      "a".repeat(25), // long unbroken word: hard wrap
      "short",
    ];
    for (const s of samples) {
      const expected = wrapAnsi(s, width, { trim: false, hard: true }).split("\n").length;
      expect(__wrappedRows(s, width)).toBe(expected);
    }
  });

  test("wrappedRows counts blank lines and trailing newlines (whole-string wrap)", () => {
    // Under the old per-segment estimator these were undercounted by 1 each.
    expect(__wrappedRows("a\n\nb", 10)).toBe(3);
    expect(__wrappedRows("a\n", 10)).toBe(2);
    expect(__wrappedRows("hello\nworld\n\nend", 10)).toBe(4);
    expect(__wrappedRows("line1\nline2 with more words filling", 10)).toBe(5);
  });

  test("empty text contributes nothing (thinking-only phase)", () => {
    const m = msg("assistant", [part(0, "thinking", { text: "thinking…" })]);
    expect(__estimateRows(m, 100, false)).toBe(2); // summary line + gap (no text yet)
  });

  test("assistant prose rows ≥ naive char-count (regression: undercount → overflow)", () => {
    // At width 80 an 400-char prose message wraps on WORD boundaries, which
    // a char-count estimate undercounts by a row or two. The estimator must
    // not drop below wrap-ansi's real count.
    const prose =
      "Round 2 results: 3/5 with a confession. Two of my questions were unanswerable as written — " +
      "I gave you character names where I asked for something else. Flagging them and grading honestly: " +
      "Brave New World is indeed a film — my parenthetical was wrong.";
    const m = msg("assistant", [part(0, "text", { text: prose })]);
    const real = wrapAnsi(prose, 100 - 7, { trim: false, hard: true }).split("\n").length;
    const est = __estimateRows(m, 100, false);
    expect(est).toBeGreaterThanOrEqual(real);
  });

  test("user box width is narrower than assistant (border + padding + app padding)", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const user = msg("user", [part(0, "text", { text })]);
    const assistant = msg("assistant", [part(0, "text", { text })]);
    // Same content at the same terminal: the user box wraps MORE (width = cols-6 vs cols-7).
    expect(__estimateRows(user, 100, false)).toBeGreaterThanOrEqual(__estimateRows(assistant, 100, false));
  });

  test("expanded thinking adds its reasoning rows; collapsed stays one line + gap", () => {
    const thinking = "line one\nline two";
    const m = msg("assistant", [part(0, "thinking", { text: thinking }), part(1, "text", { text: "reply" })]);
    const collapsed = __estimateRows(m, 100, false);
    const expanded = __estimateRows(m, 100, true);
    expect(expanded).toBeGreaterThan(collapsed);
    expect(collapsed).toBeGreaterThan(0);
  });

  test("tool calls contribute one row each plus a gap", () => {
    const call = { callId: "c1", name: "fs.read", args: '{"path":"a"}' };
    const result = { callId: "c1", content: "ok", isError: true };
    const m = msg("assistant", [part(0, "tool_call", call), part(1, "tool_result", result)]);
    // tool calls: 1 call + 1 gap = 2; no text → max(1,…)
    expect(__estimateRows(m, 100, false)).toBe(2);
  });
});