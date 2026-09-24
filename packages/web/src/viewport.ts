/**
 * visualViewport refit — tracks the *visual* viewport (the part of the page
 * not covered by the iOS keyboard / browser chrome) so the app can shrink
 * its root container when the keyboard opens.
 *
 * iOS Safari does not reliably resize the layout viewport when the keyboard
 * appears (`interactive-widget=resizes-content` helps, but WebKit ignores it
 * in standalone/PWA mode). Subscribing to `window.visualViewport` and
 * writing a CSS custom property (`--vvh`) on `:root` gives every `dvh`
 * consumer a hard floor, and lets fixed chrome (composer, KeyBar) pin to the
 * keyboard edge.
 *
 * No-ops when `visualViewport` is missing (desktop browsers, older engines).
 * `keyboardVisible` is true when the visual height has shrunk more than 120px
 * below the layout viewport — a heuristic that avoids false positives from
 * URL-bar collapse on mobile Safari.
 */

import { useEffect } from "react";

const KEYBOARD_SLOP_PX = 120;

function applyViewport(): void {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (vv === null) return;
  const height = vv.height;
  const offsetTop = vv.offsetTop;
  const layoutHeight = window.innerHeight;
  const keyboardVisible = layoutHeight - height > KEYBOARD_SLOP_PX;
  const root = document.documentElement;
  root.style.setProperty("--vvh", `${Math.round(height)}px`);
  root.style.setProperty("--vv-offset-top", `${Math.round(offsetTop)}px`);
  root.style.setProperty("--keyboard-inset", keyboardVisible ? `${Math.round(layoutHeight - height)}px` : "0px");
  root.dataset.keyboard = keyboardVisible ? "open" : "closed";
}

/**
 * Subscribe once at app boot (call from `main.tsx` / the root component).
 * Returns nothing — side-effect only. Safe to call multiple times (idempotent
 * listeners would stack, so call once).
 */
export function initViewportRefit(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const vv = window.visualViewport;
  applyViewport();
  if (vv === null) return () => undefined;
  vv.addEventListener("resize", applyViewport);
  vv.addEventListener("scroll", applyViewport);
  window.addEventListener("orientationchange", applyViewport);
  return () => {
    vv.removeEventListener("resize", applyViewport);
    vv.removeEventListener("scroll", applyViewport);
    window.removeEventListener("orientationchange", applyViewport);
  };
}

/** React wrapper — mount once near the root if you prefer a hook. */
export function useViewportRefit(): void {
  useEffect(() => initViewportRefit(), []);
}
