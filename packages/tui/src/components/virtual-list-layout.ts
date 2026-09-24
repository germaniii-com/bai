/**
 * Pure layout math for the variable-height virtual list
 * (`components/virtual-list.tsx`). Kept dependency-free so the window and
 * offset computation is unit-testable without React/Ink/terminal.
 *
 * The virtualization idea is adapted from `ink-virtual-list`
 * (https://github.com/archcorsair/ink-virtual-list, MIT © Daniel Shneyder):
 * render only the slice of items intersecting the viewport. Unlike upstream —
 * whose single integer `itemHeight` clips variable-height content — these
 * helpers work from a per-item height array (measured when an item is mounted,
 * estimated otherwise), so streaming markdown and bounded tool output render
 * at their real height.
 */

/** Clamp a scroll offset into `[0, max]` (0 when there is nothing to scroll). */
export function clampOffset(value: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(value, max));
}

/**
 * Prefix offsets for `heights`: `offsets[i]` is the top row of item `i` from
 * the content start, `offsets[N]` the total content height. Purely additive —
 * O(N) arithmetic, never layout.
 */
export function computeOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    offsets[i + 1] = (offsets[i] ?? 0) + (h !== undefined && Number.isFinite(h) ? Math.max(0, h) : 0);
  }
  return offsets;
}

/**
 * Greatest item index `i` in `[0, count)` whose top row is `<= y` — i.e. the
 * item containing row `y`. Returns 0 when `y` is above the first item (pin the
 * window to the start) and the last index when `y` is past the total.
 */
function itemAtOrAbove(offsets: readonly number[], y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return -1;
  if (y < (offsets[0] ?? 0)) return 0;
  let lo = 0;
  let hi = count; // offsets[count] is the total height
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((offsets[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, count - 1);
}

/**
 * The inclusive index window `[first, last]` of items intersecting the
 * viewport at `scrollOffset`, widened by `overscanItems` on each side (so a
 * row or two of runway is mounted/measured outside the viewport). Returns
 * `null` for an empty list.
 */
export function findWindow(
  offsets: readonly number[],
  scrollOffset: number,
  viewportHeight: number,
  overscanItems: number,
): { first: number; last: number } | null {
  const count = offsets.length - 1;
  if (count <= 0) return null;
  const top = Math.max(0, scrollOffset);
  const bottom = top + Math.max(0, viewportHeight);
  const firstVisible = itemAtOrAbove(offsets, top);
  const lastVisible = itemAtOrAbove(offsets, bottom);
  const over = Math.max(0, Math.floor(overscanItems));
  const first = Math.max(0, firstVisible - over);
  const last = Math.min(count - 1, lastVisible + over);
  return last < first ? null : { first, last };
}
