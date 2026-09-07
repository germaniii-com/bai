import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/** A compact icon control with a durable accessible name and hover/focus hint. */
export function IconButton({
  label,
  hint = label,
  children,
  className = "",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={hint}
      data-tooltip={hint}
    >
      {children}
    </button>
  );
}

/** Trap Tab focus in a modal and return focus to its trigger on close. */
export function useDialogFocus(open: boolean, dialogRef: React.RefObject<HTMLElement | null>, returnRef?: React.RefObject<HTMLElement | null>) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = returnRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    const first = focusable()[0];
    queueMicrotask(() => (first ?? dialog).focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const current = document.activeElement;
      const index = items.indexOf(current as HTMLElement);
      const next = event.shiftKey
        ? (index <= 0 ? items[items.length - 1] : items[index - 1])
        : (index === items.length - 1 ? items[0] : items[index + 1]);
      if (next !== undefined) {
        event.preventDefault();
        next.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreRef.current?.focus();
    };
  }, [open, dialogRef, returnRef]);
}
