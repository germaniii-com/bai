import { describe, expect, test } from "bun:test";
import { moveFocus } from "../src/state/focus";

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
