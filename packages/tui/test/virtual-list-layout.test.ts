import { describe, expect, test } from "bun:test";
import { clampOffset, computeOffsets, findWindow } from "../src/components/virtual-list-layout";

/**
 * Pure layout math for the virtual list: prefix offsets, offset clamping, and
 * the visible index window. These are the O(N)-arithmetic / O(log N) search
 * pieces that keep rendering O(visible).
 */
describe("virtual-list-layout", () => {
  describe("computeOffsets", () => {
    test("builds prefix sums with a trailing total", () => {
      expect(computeOffsets([1, 1, 1])).toEqual([0, 1, 2, 3]);
      expect(computeOffsets([3, 5, 2])).toEqual([0, 3, 8, 10]);
    });

    test("empty list yields a single zero offset", () => {
      expect(computeOffsets([])).toEqual([0]);
    });

    test("negative/non-finite heights are treated as zero", () => {
      expect(computeOffsets([2, -5, 3])).toEqual([0, 2, 2, 5]);
      expect(computeOffsets([2, Number.NaN, 3])).toEqual([0, 2, 2, 5]);
    });
  });

  describe("clampOffset", () => {
    test("clamps into [0, max]", () => {
      expect(clampOffset(-4, 10)).toBe(0);
      expect(clampOffset(4, 10)).toBe(4);
      expect(clampOffset(40, 10)).toBe(10);
    });

    test("non-positive max collapses to zero", () => {
      expect(clampOffset(5, 0)).toBe(0);
      expect(clampOffset(5, -3)).toBe(0);
    });
  });

  describe("findWindow", () => {
    // 30 one-row items in a 9-row viewport.
    const offsets = computeOffsets(Array.from({ length: 30 }, () => 1));

    test("windows the viewport, no overscan", () => {
      expect(findWindow(offsets, 21, 9, 0)).toEqual({ first: 21, last: 29 });
      expect(findWindow(offsets, 0, 9, 0)).toEqual({ first: 0, last: 9 });
    });

    test("widens by overscan on both sides", () => {
      expect(findWindow(offsets, 21, 9, 2)).toEqual({ first: 19, last: 29 });
      expect(findWindow(offsets, 10, 9, 2)).toEqual({ first: 8, last: 21 });
    });

    test("clamps overscan at both ends", () => {
      expect(findWindow(offsets, 0, 9, 2)).toEqual({ first: 0, last: 11 });
      // Overscan past the bottom clamps to the last index.
      const w = findWindow(offsets, 21, 9, 50);
      expect(w?.first).toBe(0);
      expect(w?.last).toBe(29);
    });

    test("empty list yields null", () => {
      expect(findWindow([0], 0, 10, 2)).toBeNull();
    });

    test("short content fits entirely", () => {
      const short = computeOffsets([2, 2, 2]);
      expect(findWindow(short, 0, 20, 2)).toEqual({ first: 0, last: 2 });
    });

    test("variable heights: a tall item spans the whole window", () => {
      // offsets: [0, 1, 40, 41, 42]; a 39-row item at index 1.
      const tall = computeOffsets([1, 39, 1, 1]);
      // Viewport [0,10) lands inside item 1 → items 0..2 cover it.
      expect(findWindow(tall, 0, 10, 0)).toEqual({ first: 0, last: 1 });
      // Viewport [30,40) is inside item 1; item 2 starts exactly at its bottom
      // edge and is included (harmless — clipped, and covered by overscan).
      expect(findWindow(tall, 30, 10, 0)).toEqual({ first: 1, last: 2 });
    });

    test("offset past the total pins the window to the tail", () => {
      const w = findWindow(offsets, 999, 9, 0);
      expect(w).toEqual({ first: 29, last: 29 });
    });
  });
});
