import { useCallback, useEffect, useRef } from "react";

/**
 * Long-press → callback (iOS-friendly context menu opener).
 *
 * iOS Safari does not reliably fire `contextmenu` on touch long-press
 * (and many WebViews never do). This helper starts a timer on
 * `pointerdown` (covers mouse + touch + pen via pointer events) and
 * fires once if the pointer stays down past `ms` without cancelling.
 *
 * Usage:
 *   const bindLongPress = useLongPress();
 *   <ListItem {...bindLongPress((x, y) => openMenu(x, y, path))} />
 *
 * Movement beyond `slop` px cancels (treats the gesture as a scroll/drag).
 * After a fire, the subsequent `click` is swallowed once so a long-press
 * doesn't also activate the row's primary action. Keep the desktop
 * `onContextMenu` path for right-click / ctrl-click.
 */
export function useLongPress(options?: { ms?: number; slop?: number; enabled?: boolean }): (
  onLongPress: (clientX: number, clientY: number) => void,
) => {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onClick: (e: React.MouseEvent) => void;
} {
  const ms = options?.ms ?? 450;
  const slop = options?.slop ?? 10;
  const enabled = options?.enabled ?? true;

  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const callbackRef = useRef<((x: number, y: number) => void) | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  // Unmount safety — never leave a timer pointing at a dead tree.
  useEffect(() => clear, [clear]);

  return useCallback(
    (onLongPress: (clientX: number, clientY: number) => void) => ({
      onPointerDown: (e: React.PointerEvent) => {
        if (!enabled || e.button !== 0) return;
        firedRef.current = false;
        callbackRef.current = onLongPress;
        startRef.current = { x: e.clientX, y: e.clientY };
        const { clientX, clientY } = e;
        clear();
        timerRef.current = window.setTimeout(() => {
          firedRef.current = true;
          timerRef.current = null;
          startRef.current = null;
          // Best-effort: suppress the native callout if WebKit still fires one.
          try {
            e.preventDefault();
          } catch {
            /* synthetic / already defaulted */
          }
          onLongPress(clientX, clientY);
        }, ms);
      },
      onPointerUp: () => clear(),
      onPointerCancel: () => clear(),
      onPointerMove: (e: React.PointerEvent) => {
        const start = startRef.current;
        if (start === null || timerRef.current === null) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (dx * dx + dy * dy > slop * slop) clear();
      },
      /** Swallow the click that follows a long-press (once). */
      onClick: (e: React.MouseEvent) => {
        if (firedRef.current) {
          firedRef.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      },
    }),
    [clear, enabled, ms],
  );
}
