/**
 * Pure focus-traversal math for the NORMAL-mode transcript navigator — no
 * rendering, no Ink, so the vim-motion behavior is unit-testable without a
 * terminal (same pattern as state/composer.ts and state/history.ts).
 *
 * Focus is an index into the message list (`0` = oldest, `len - 1` = newest)
 * or null when nothing is focused. The scroll `offset` counts messages
 * hidden from the bottom (0 = pinned to latest) — the same single scroll
 * truth the chat view already uses; snapping adjusts it when focus leaves
 * the rendered window.
 */

/**
 * Step the focus one message down (newer) or up (older), clamped to
 * `[0, len - 1]`. The caller seeds the first press (null → last visible
 * message); an empty transcript has no focus.
 */
export function moveFocus(focus: number, len: number, down: boolean): number {
  const next = focus + (down ? 1 : -1);
  return Math.max(0, Math.min(next, len - 1));
}

/**
 * Adjust the scroll offset so the focused message stays inside the rendered
 * window `[winStart, winEnd)` (indices into the message list):
 * - focus above the window top → shift the window up by the deficit
 *   (focus lands on the new window top);
 * - focus below the window bottom → pin the window's bottom edge to focus
 *   (`end = len - offset` → `offset = len - 1 - focus`);
 * - focus inside → offset unchanged.
 * The result is clamped to `[0, len - 1]`, matching the chat view's offset
 * clamp (offset can never hide more than all but one message).
 */
export function snapOffset(
  focus: number,
  len: number,
  offset: number,
  winStart: number,
  winEnd: number,
): number {
  let next = offset;
  if (focus < winStart) next = offset + (winStart - focus);
  else if (focus >= winEnd) next = len - 1 - focus;
  return Math.max(0, Math.min(next, Math.max(0, len - 1)));
}
