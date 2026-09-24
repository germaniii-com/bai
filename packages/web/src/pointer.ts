/**
 * Pointer-capability helpers for touch/iOS friendliness.
 *
 * `pointer: coarse` is the one signal that means "finger, not mouse" —
 * used to suppress mount-time autofocus (iOS Safari raises the keyboard —
 * and used to zoom the page — the moment a modal focuses a field) and to
 * size SVG/chart text that can't read CSS tokens.
 */

import { useEffect, useState } from "react";

/** True when the primary pointer is coarse (touch). */
export function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/**
 * Mount-time `autoFocus` gate: focus fields on desktop, skip on touch so
 * opening a modal never pops the keyboard (or triggers the pre-16px iOS
 * zoom). Explicit focus (tap-to-edit, the composer focus token) still works.
 */
export function shouldAutoFocus(): boolean {
  return !isCoarsePointer();
}

/** Reactive `pointer: coarse` flag (subscribes to the media query). */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState<boolean>(isCoarsePointer);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = (): void => setCoarse(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return coarse;
}
