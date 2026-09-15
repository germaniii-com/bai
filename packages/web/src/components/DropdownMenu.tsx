import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MenuList, useMenuDismiss, type ContextMenuItem } from "./ContextMenu";

const MARGIN = 8;
const GAP = 4;

/**
 * An actions menu anchored to its trigger (the image-card "…" menus). Shares
 * MenuList + dismissal with ContextMenu: portal, viewport clamp, roving focus,
 * arrow/Home/End keys, outside/scroll/resize/Esc dismiss.
 */
export function DropdownMenu({
  button,
  items,
  ariaLabel = "Actions",
  align = "start",
  className,
}: {
  /** The trigger's inner content (rendered inside the shared trigger button). */
  button: React.ReactNode;
  items: ContextMenuItem[];
  ariaLabel?: string;
  align?: "start" | "end";
  /** Extra classes on the trigger button. */
  className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const el = menuRef.current;
    if (trigger === null || el === null) return;
    const t = trigger.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    const rawLeft = align === "end" ? t.right - m.width : t.left;
    const rawTop = t.bottom + GAP;
    setPos({
      left: Math.max(MARGIN, Math.min(rawLeft, window.innerWidth - m.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(rawTop, window.innerHeight - m.height - MARGIN)),
    });
  }, [open, align]);

  // When open, treat the menu as inside for dismissal purposes (the trigger
  // toggles on click, so it must not count as an outside press).
  useMenuDismiss(menuRef, () => setOpen(false), triggerRef);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`dropdown-trigger ${className ?? ""}`.trim()}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={pos === null ? { position: "fixed", visibility: "hidden" } : { position: "fixed", left: pos.left, top: pos.top }}
          >
            <MenuList
              items={items}
              onClose={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              ariaLabel={ariaLabel}
              className="dropdown-menu"
            />
          </div>,
          document.body,
        )}
    </>
  );
}
