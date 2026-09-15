import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";
import { useDialogFocus } from "./useDialogFocus";

/** Matches --duration-normal; the enter/exit animation length. */
const ANIM_MS = 180;

type Phase = "hidden" | "entering" | "visible" | "exiting";

/**
 * The unified modal wrapper: overlay + dialog + header (title + close) +
 * scrollable body + optional footer. Esc-to-close, backdrop-click close, the
 * Tab focus trap (with focus restore), and a subtle enter/exit animation are
 * built in — callers only supply content.
 *
 * Sizes: sm 520px (pickers, confirms), md 720px (forms, the model picker),
 * lg 880px (galleries). Mobile (≤640px): full-width, 85vh, scrollable body.
 *
 * `onEscape` may intercept Escape (return true to keep the dialog open).
 * `animate={false}` mounts/unmounts instantly.
 */
export function Modal({
  open,
  onClose,
  title,
  size = "md",
  footer,
  children,
  ariaLabel,
  bodyClassName,
  className,
  animate = true,
  closeOnBackdrop = true,
  onEscape,
}: {
  /** False starts the exit animation (or unmounts when `animate` is false). */
  open: boolean;
  onClose: () => void;
  /** Header text (or node) + the unified close button. */
  title: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Sticky footer row (actions). Buttons wrap on mobile. */
  footer?: ReactNode;
  children: ReactNode;
  /** Accessible dialog name; defaults to the title's text content. */
  ariaLabel?: string;
  /** Passthrough for full-bleed bodies ("unpadded") or extra body classes. */
  bodyClassName?: string;
  /** Extra classes on the dialog element (e.g. a domain class). */
  className?: string;
  /** Enter/exit animation. Default true. */
  animate?: boolean;
  /** Backdrop click closes. Default true. */
  closeOnBackdrop?: boolean;
  /** Intercept Escape; return true to keep the dialog open. */
  onEscape?: () => boolean | void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(open ? (animate ? "entering" : "visible") : "hidden");

  // Drive the phase machine from the `open` prop.
  useEffect(() => {
    if (!animate) {
      setPhase(open ? "visible" : "hidden");
      return;
    }
    if (open && phase === "hidden") setPhase("entering");
    else if (!open && (phase === "visible" || phase === "entering")) setPhase("exiting");
  }, [open, animate, phase]);

  useEffect(() => {
    if (!animate || phase !== "entering") return;
    const timer = setTimeout(() => setPhase("visible"), ANIM_MS);
    return () => clearTimeout(timer);
  }, [phase, animate]);

  useEffect(() => {
    if (!animate || phase !== "exiting") return;
    const timer = setTimeout(() => setPhase("hidden"), ANIM_MS);
    return () => clearTimeout(timer);
  }, [phase, animate]);

  useDialogFocus(phase !== "hidden", dialogRef);

  // Esc closes (the focus trap owns Tab; this owns Escape).
  useEffect(() => {
    if (phase === "hidden") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (onEscape !== undefined && onEscape() === true) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose, onEscape]);

  if (phase === "hidden") return null;

  const classes = [
    "modal",
    size === "sm" ? "modal-sm" : size === "lg" ? "modal-lg" : "",
    phase === "entering" ? "modal-entering" : phase === "exiting" ? "modal-exiting" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={phase === "exiting" ? "modal-overlay exiting" : "modal-overlay"}
      onClick={closeOnBackdrop ? onClose : undefined}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={classes}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 className="modal-title">{title}</h3>
          <IconButton className="modal-close" label="Close dialog" hint="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
        <div className={bodyClassName !== undefined ? `modal-body ${bodyClassName}` : "modal-body"}>
          {children}
        </div>
        {footer !== undefined && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
