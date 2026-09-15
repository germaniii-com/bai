import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The dialog-picker trigger (agent/model/theme pickers): a bordered control
 * showing a label + current value + caret, opening a picker Modal. Screens
 * used to hand-roll this five times as `.model-button`.
 */
export function PickerTrigger({
  label,
  value,
  onClick,
  ariaLabel,
  icon,
  trailing,
  disabled = false,
  className,
}: {
  /** Small dim prefix (e.g. "agent", "model"). */
  label?: ReactNode;
  value: ReactNode;
  onClick: () => void;
  ariaLabel?: string;
  icon?: ReactNode;
  /** Extra slot before the caret (capability badges, etc.). */
  trailing?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`picker-trigger ${className ?? ""}`.trim()}
      onClick={onClick}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-label={ariaLabel}
    >
      {icon !== undefined && (
        <span className="picker-trigger-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {label !== undefined && <span className="picker-trigger-label">{label}</span>}
      <span className="picker-trigger-value">{value}</span>
      {trailing}
      <span className="picker-trigger-caret" aria-hidden="true">
        <ChevronDown size={12} />
      </span>
    </button>
  );
}
