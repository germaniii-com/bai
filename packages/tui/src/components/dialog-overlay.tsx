import { Box } from "ink";
import type { ReactNode } from "react";

/**
 * The opencode-style dialog shell: a floating panel over the LIVE view
 * (the chat stays mounted and visible behind — dialogs no longer swap the
 * render branch). Ink has no alpha blending, so the backdrop is transparent
 * (no dimming) and the panel itself paints an opaque surface; the dialog
 * components own their borders/background — this shell only positions and
 * sizes.
 *
 * Geometry (opencode's Dialog): full-terminal absolute box, panel offset
 * ¼ from the top, fixed width (72 — opencode's medium 60 plus room for the
 * hint/badge columns), clamped to the terminal. The list height is capped
 * separately via `overlayWindowSize` (passed down as each dialog's window
 * size) so the panel never exceeds ~60% of the terminal and the hints row
 * never clips.
 */

/** Default panel width (opencode's medium is 60 — bai runs a bit wider). */
const PANEL_WIDTH = 72;

/**
 * List rows a dialog may show at `rows` terminal height: ~60% of the
 * terminal minus the chrome (title + filter + hints + borders ≈ 5-6 rows),
 * clamped to [3, 12] (12 = SelectDialog's default window).
 */
export function overlayWindowSize(rows: number): number {
  return Math.max(3, Math.min(12, Math.floor(rows * 0.6) - 5));
}

export function DialogOverlay({
  columns,
  rows,
  width = PANEL_WIDTH,
  children,
}: {
  columns: number;
  rows: number;
  /** Panel width in columns (clamped to the terminal). */
  width?: number;
  children: ReactNode;
}) {
  return (
    // Absolute overlay: paints OVER the frame's earlier siblings (the chat)
    // without consuming flex space — the layout below is untouched, so the
    // hub chip hit-testing math stays valid. No backgroundColor: the
    // backdrop stays transparent (Ink has no alpha) and the chat shows.
    <Box
      position="absolute"
      top={0}
      left={0}
      width={columns > 0 ? columns : undefined}
      height={rows > 0 ? rows : undefined}
      flexDirection="column"
      alignItems="center"
      paddingTop={Math.max(0, Math.floor(rows / 4))}
    >
      <Box flexDirection="column" width={Math.min(width, Math.max(20, columns - 2))}>
        {children}
      </Box>
    </Box>
  );
}
