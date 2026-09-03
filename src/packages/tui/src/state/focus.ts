/**
 * Pure focus-traversal math for the NORMAL-mode transcript navigator — no
 * rendering, no Ink, so the vim-motion behavior is unit-testable without a
 * terminal (same pattern as state/composer.ts and state/history.ts).
 *
 * Focus is an index into the message list (`0` = oldest, `len - 1` = newest)
 * or null when nothing is focused. The chat view scrolls BY ROWS to reveal
 * the focused message (continuous scroll — components/scroll-view.tsx), so
 * there is no message-window snapping math here anymore.
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
