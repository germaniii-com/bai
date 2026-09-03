import { describe, expect, test } from "bun:test";
import { listWindow } from "../src/components/dialog";

/**
 * The sliding list window shared by every picker dialog (sessions, agents &
 * tools, providers/models): the cursor stays inside the window, short lists
 * render in full, and the window clamps at both ends.
 */
describe("listWindow (dialog list scrolling)", () => {
  test("cursor at the top pins the window to the start", () => {
    expect(listWindow(0, 30, 12)).toEqual({ start: 0, end: 12 });
    expect(listWindow(6, 30, 12)).toEqual({ start: 0, end: 12 }); // still inside
  });

  test("cursor in the middle centers the window around it", () => {
    expect(listWindow(15, 30, 12)).toEqual({ start: 9, end: 21 });
  });

  test("cursor at the bottom pins the window to the end", () => {
    expect(listWindow(29, 30, 12)).toEqual({ start: 18, end: 30 });
  });

  test("short lists render in full (window ≥ count)", () => {
    expect(listWindow(0, 5, 12)).toEqual({ start: 0, end: 5 });
    expect(listWindow(4, 5, 12)).toEqual({ start: 0, end: 5 });
  });

  test("empty list yields an empty slice", () => {
    const w = listWindow(0, 0, 12);
    expect(w.start).toBe(0);
    expect(w.end).toBeLessThanOrEqual(1);
  });
});
