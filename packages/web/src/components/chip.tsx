import type { ReactNode } from "react";
import { X } from "lucide-react";

/**
 * The one chip: composer chips, linked-file chips, queued chips, combobox
 * selections. Static by default; `interactive` makes it a button;
 * `onRemove` adds the ✕ affordance.
 */
export function Chip({
  children,
  interactive = false,
  selected = false,
  add = false,
  onRemove,
  removeLabel,
  onClick,
  hint,
  className,
}: {
  children: ReactNode;
  /** Renders as a button with hover state. */
  interactive?: boolean;
  selected?: boolean;
  /** Dimmed "+ add" affordance style. */
  add?: boolean;
  /** Shows the ✕ remove button (implies interactive rendering). */
  onRemove?: () => void;
  removeLabel?: string;
  onClick?: () => void;
  /** Hover hint (global tooltip layer). */
  hint?: string;
  className?: string;
}) {
  const classes = [
    "chip",
    interactive || onRemove !== undefined ? "interactive" : "",
    selected ? "selected" : "",
    add ? "add" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const inner = (
    <>
      {children}
      {onRemove !== undefined && (
        <button
          type="button"
          className="chip-remove"
          aria-label={removeLabel ?? "Remove"}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </>
  );
  if (interactive || onRemove !== undefined) {
    return (
      <button type="button" className={classes} onClick={onClick} data-tooltip={hint}>
        {inner}
      </button>
    );
  }
  return <span className={classes} data-tooltip={hint}>{inner}</span>;
}
