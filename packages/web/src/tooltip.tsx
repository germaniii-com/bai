import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ActiveTip {
  text: string;
  /** Trigger rect captured at show time (viewport coordinates). */
  rect: DOMRect;
}

/** Gap between the trigger and the tooltip, and the viewport margin. */
const MARGIN = 8;

/** How long the pointer/focus must rest on a trigger before the hint shows. */
const TOOLTIP_DELAY_MS = 500;

/**
 * One global, fixed-position tooltip for every `[data-tooltip]` control.
 *
 * The previous CSS `::after` tooltips were clipped by scroll/overflow
 * ancestors (the composer, the session sidebar, the file tree) and stacked
 * under later content. A single portal-rendered layer at a very high
 * z-index is never clipped, and clamps itself to the viewport (flipping
 * below the trigger when there is no room above).
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<ActiveTip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const show = (el: HTMLElement): void => {
      const text = el.getAttribute("data-tooltip") ?? "";
      if (text.length === 0) return;
      current = el;
      setPos(null);
      setTip({ text, rect: el.getBoundingClientRect() });
    };

    // Entering a trigger arms a one-second timer; the hint only appears once
    // the pointer/focus has rested there that long (and leaves immediately).
    const arm = (el: HTMLElement): void => {
      if (el === current) return;
      clearTimer();
      current = el;
      timer = setTimeout(() => {
        timer = undefined;
        if (current === el) show(el);
      }, TOOLTIP_DELAY_MS);
    };

    const hide = (): void => {
      clearTimer();
      current = null;
      setTip(null);
      setPos(null);
    };

    const onOver = (e: MouseEvent): void => {
      const el = (e.target as Element | null)?.closest?.(
        "[data-tooltip]",
      ) as HTMLElement | null;
      if (el !== null) arm(el);
    };
    const onOut = (e: MouseEvent): void => {
      if (current === null) return;
      const related = e.relatedTarget as Node | null;
      if (related !== null && current.contains(related)) return;
      hide();
    };
    const onFocusIn = (e: FocusEvent): void => {
      const el = (e.target as Element | null)?.closest?.(
        "[data-tooltip]",
      ) as HTMLElement | null;
      if (el !== null) arm(el);
    };
    const onFocusOut = (): void => hide();

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // A press invalidates the hover (e.g. a modal is about to open).
    document.addEventListener("pointerdown", hide);
    // Any scroll/resize invalidates the captured rect — dismiss.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  // Measure the rendered tooltip, then clamp to the viewport and flip below
  // the trigger when there is not enough room above.
  useLayoutEffect(() => {
    if (tip === null) return;
    const el = ref.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = tip.rect.left + tip.rect.width / 2 - r.width / 2;
    left = Math.max(MARGIN, Math.min(left, vw - r.width - MARGIN));
    let top = tip.rect.top - r.height - MARGIN;
    if (top < MARGIN) top = tip.rect.bottom + MARGIN;
    if (top + r.height > vh - MARGIN)
      top = Math.max(MARGIN, vh - r.height - MARGIN);
    setPos({ left, top });
  }, [tip]);

  if (tip === null) return null;
  return createPortal(
    <div
      ref={ref}
      className="app-tooltip"
      role="tooltip"
      style={
        pos === null
          ? { left: 0, top: 0, visibility: "hidden" }
          : { left: pos.left, top: pos.top, visibility: "visible" }
      }
    >
      {tip.text}
    </div>,
    document.body,
  );
}
