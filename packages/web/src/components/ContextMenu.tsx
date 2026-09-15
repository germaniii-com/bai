import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** Gap between a floating menu and the viewport edges. */
const MARGIN = 8;

/**
 * The shared menu panel: roving-focus item list with ↑/↓ wrap, Home/End, and
 * Tab-to-close. Positioned by its wrapper (ContextMenu at the pointer,
 * DropdownMenu under its trigger).
 */
export function MenuList({
  items,
  onClose,
  ariaLabel = "Actions",
  className,
  style,
}: {
  items: ContextMenuItem[];
  onClose: () => void;
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const firstEnabled = items.findIndex((item) => item.disabled !== true);
  const [active, setActive] = useState(firstEnabled < 0 ? 0 : firstEnabled);

  // Focus the first enabled item on open.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")?.focus();
  }, [items]);

  const enabled = items.flatMap((item, i) => (item.disabled === true ? [] : [i]));
  const move = (delta: number): void => {
    if (enabled.length === 0) return;
    const current = enabled.indexOf(active);
    const next = current < 0 ? 0 : (current + delta + enabled.length) % enabled.length;
    setActive(enabled[next] as number);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      if (enabled[0] !== undefined) setActive(enabled[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      if (enabled.length > 0) setActive(enabled[enabled.length - 1] as number);
    } else if (e.key === "Tab") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      className={`menu ${className ?? ""}`.trim()}
      role="menu"
      aria-label={ariaLabel}
      style={style}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger === true ? "menu-item danger" : "menu-item"}
          disabled={item.disabled === true}
          tabIndex={i === active ? 0 : -1}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => item.onSelect()}
        >
          {item.icon !== undefined && (
            <span className="menu-icon" aria-hidden="true">
              {item.icon}
            </span>
          )}
          <span className="menu-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A right-click action menu. Portaled to <body> and fixed-positioned at the
 * pointer, then clamped to the viewport — so it is never clipped by a scroll
 * container. Click-outside, scroll, resize, and Esc dismiss it.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  ariaLabel = "Actions",
}: {
  /** Viewport coordinates of the pointer at open time. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Clamp to the viewport once the real size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(x, window.innerWidth - r.width - MARGIN));
    const top = Math.max(MARGIN, Math.min(y, window.innerHeight - r.height - MARGIN));
    setPos({ left, top });
  }, [x, y]);

  // Restore the prior focus on close.
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => restoreRef.current?.focus();
  }, []);

  useMenuDismiss(ref, onClose);

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={pos === null ? { left: x, top: y, visibility: "hidden" } : { left: pos.left, top: pos.top }}
    >
      <MenuList items={items} onClose={onClose} ariaLabel={ariaLabel} />
    </div>,
    document.body,
  );
}

/**
 * Dismiss a floating menu on outside mousedown, Escape, scroll, or resize.
 * `roots` are the elements considered "inside" (the panel, and any trigger).
 */
export function useMenuDismiss(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  ...roots: React.RefObject<HTMLElement | null>[]
): void {
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (ref.current !== null && ref.current.contains(target)) return;
      for (const root of roots) {
        if (root.current !== null && root.current.contains(target)) return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [ref, onClose, roots]);
}
