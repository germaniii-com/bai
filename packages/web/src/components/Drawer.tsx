import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";
import { useDialogFocus } from "./useDialogFocus";

/** Enter/exit animation length — matches Modal's ANIM_MS. */
const ANIM_MS = 180;

type Phase = "hidden" | "entering" | "visible" | "exiting";

export interface DrawerTab {
  id: string;
  label: string;
}

/**
 * Right-edge slide-over drawer (mobile workspace rail).
 *
 * Sibling of Modal with a different geometry: docks to the right, enters
 * with a translateX, and carries an optional tab strip for switching the
 * panel's contents (Files / Todos / Notes / Plans). Same interaction
 * contract as Modal — `role="dialog"`, focus trap (`useDialogFocus`),
 * Esc + backdrop close, portal-free (fixed overlay).
 *
 * Body height is `min(100%, …)` with internal scroll so content never
 * exceeds the dynamic viewport (keyboard / home indicator under
 * `viewport-fit=cover`).
 */
export function Drawer({
  open,
  onClose,
  title,
  tabs,
  activeTab,
  onTabChange,
  children,
  ariaLabel,
  footer,
  bodyClassName,
}: {
  open: boolean;
  onClose: () => void;
  /** Header text (or node). */
  title: ReactNode;
  /** Optional tab strip (mobile rail panels). */
  tabs?: DrawerTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  children: ReactNode;
  ariaLabel?: string;
  /** Sticky footer row (actions). */
  footer?: ReactNode;
  /** Extra class on `.drawer-body` (e.g. full-bleed panel like the file tree). */
  bodyClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(open ? "entering" : "hidden");

  useEffect(() => {
    if (open && phase === "hidden") setPhase("entering");
    else if (!open && (phase === "visible" || phase === "entering")) setPhase("exiting");
  }, [open, phase]);

  useEffect(() => {
    if (phase !== "entering") return;
    const timer = window.setTimeout(() => setPhase("visible"), ANIM_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "exiting") return;
    const timer = window.setTimeout(() => setPhase("hidden"), ANIM_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useDialogFocus(phase !== "hidden", panelRef);

  useEffect(() => {
    if (phase === "hidden") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  if (phase === "hidden") return null;

  const classes = [
    "drawer",
    phase === "entering" ? "drawer-entering" : phase === "exiting" ? "drawer-exiting" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={phase === "exiting" ? "drawer-overlay exiting" : "drawer-overlay"}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={classes}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h3 className="drawer-title">{title}</h3>
          <IconButton className="drawer-close" label="Close panel" hint="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
        {tabs !== undefined && tabs.length > 0 && (
          <div className="drawer-tabs" role="tablist" aria-label={typeof title === "string" ? title : "Panel sections"}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className={tab.id === activeTab ? "drawer-tab active" : "drawer-tab"}
                aria-selected={tab.id === activeTab}
                onClick={() => onTabChange?.(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        <div className={bodyClassName === undefined ? "drawer-body" : `drawer-body ${bodyClassName}`}>{children}</div>
        {footer !== undefined && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>
  );
}
