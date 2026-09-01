import { describe, expect, test } from "bun:test";
import { moveFocus, snapOffset } from "../src/state/focus";

describe("moveFocus", () => {
  test("steps down (newer) and up (older)", () => {
    expect(moveFocus(2, 10, true)).toBe(3);
    expect(moveFocus(2, 10, false)).toBe(1);
  });

  test("clamps at both ends", () => {
    expect(moveFocus(9, 10, true)).toBe(9); // newest — pinned
    expect(moveFocus(0, 10, false)).toBe(0); // oldest — pinned
  });

  test("single message: focus stays at 0", () => {
    expect(moveFocus(0, 1, true)).toBe(0);
    expect(moveFocus(0, 1, false)).toBe(0);
  });
});

describe("snapOffset", () => {
  test("focus inside the window: offset unchanged", () => {
    expect(snapOffset(5, 20, 0, 3, 14)).toBe(0);
    expect(snapOffset(5, 20, 4, 3, 14)).toBe(4);
  });

  test("focus above the window top: window shifts up by the deficit", () => {
    // window [10, 20), focus 7 → shift up 3
    expect(snapOffset(7, 30, 10, 10, 20)).toBe(13);
    // landing exactly on the new window top
    expect(snapOffset(7, 30, 13, 7, 17)).toBe(13);
  });

  test("focus below the window bottom: bottom edge pins to focus", () => {
    // window [0, 10), focus 12 → end must exceed 12 → offset = 30-1-12 = 17
    expect(snapOffset(12, 30, 0, 0, 10)).toBe(17);
    // window [0, 10), focus 10 (just past the exclusive end) → offset = 19
    expect(snapOffset(10, 30, 0, 0, 10)).toBe(19);
  });

  test("result clamps to [0, len-1]", () => {
    expect(snapOffset(0, 5, 0, 0, 5)).toBe(0); // no negative offset
    // shift-up raw result 4+3=7 clamps to len-1 = 4
    expect(snapOffset(0, 5, 4, 3, 5)).toBe(4);
    // bottom-pin of the newest message always lands at offset 0
    expect(snapOffset(4, 5, 99, 0, 1)).toBe(0);
  });

  test("focus on the newest message pins to the bottom (offset 0)", () => {
    expect(snapOffset(19, 20, 5, 0, 10)).toBe(0);
  });
});
