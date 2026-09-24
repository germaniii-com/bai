/**
 * Shared editor/terminal font config — one source of truth for Monaco and
 * xterm, so the code surfaces can never drift from each other.
 *
 * The family mirrors the `--font-mono` token in styles.css (JetBrains Mono
 * Variable, self-hosted via fonts.css). Monaco and xterm take concrete
 * strings, not CSS variables, so the stack is duplicated here deliberately —
 * keep the two in sync.
 *
 * Size is the `--text-md` step (13px) of the type scale on fine pointers;
 * coarse pointers get 16px so the code surfaces are readable on a phone
 * (and match `--control-text`'s touch floor). Callers use
 * `useEditorFontSize()` so a pointer-capability change re-renders.
 */

import { useEffect, useState } from "react";
import { isCoarsePointer } from "./pointer";

/** JetBrains Mono first, then the system mono fallbacks (matches --font-mono). */
export const EDITOR_FONT_FAMILY =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** Editor/terminal font size in px on fine pointers (the --text-md step). */
export const EDITOR_FONT_SIZE = 13;

/** Editor/terminal font size in px on coarse pointers (iOS 16px floor). */
export const EDITOR_FONT_SIZE_COARSE = 16;

/** Static size for module-init / non-reactive call sites. */
export function editorFontSize(): number {
  return isCoarsePointer() ? EDITOR_FONT_SIZE_COARSE : EDITOR_FONT_SIZE;
}

/**
 * Reactive editor/terminal font size — 13px on desktop, 16px on touch.
 * Subscribes to the `pointer: coarse` media query so a capability change
 * (rare — external display, emulator attach) re-renders the surface.
 */
export function useEditorFontSize(): number {
  const [size, setSize] = useState<number>(editorFontSize);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = (): void => setSize(mq.matches ? EDITOR_FONT_SIZE_COARSE : EDITOR_FONT_SIZE);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return size;
}
