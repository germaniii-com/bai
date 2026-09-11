import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton, useDialogFocus } from "../ui";

/**
 * The unified modal wrapper: overlay + dialog + header (title + close) +
 * scrollable body + optional footer. Esc-to-close, backdrop-click close, and
 * the Tab focus trap (with focus restore) are built in — callers only supply
 * content. Replaces the five hand-rolled copies of this plumbing.
 *
 * Sizes: sm 520px (pickers), md 720px (forms, the model picker),
 * lg 880px (galleries). Mobile (≤640px): full-width, 85vh, scrollable body.
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
}: {
  /** False renders nothing (callers may mount/unmount instead — both work). */
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
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialogRef);

  // Esc closes (the focus trap owns Tab; this owns Escape).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const classes = ["modal", size === "sm" ? "modal-sm" : size === "lg" ? "modal-lg" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
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
