import { useId, type ReactNode } from "react";

/**
 * The one switch/toggle control: a role="switch" checkbox styled as a
 * track + knob, with an optional inline label. Unlike ToggleRow (a full-row
 * checkbox), this reads as an on/off switch — used for the automation
 * Enabled state.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  ariaLabel,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Inline label beside the switch (also the accessible name). */
  label?: ReactNode;
  /** Accessible name when no visible label is rendered (e.g. a compact row). */
  ariaLabel?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <label className={className !== undefined ? `switch-row ${className}` : "switch-row"} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="toggle-switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label !== undefined && <span className="switch-label">{label}</span>}
    </label>
  );
}

/**
 * A form-row switch: title (+ optional description) on the left, the switch
 * on the right. Unlike `ToggleRow` (a standalone bordered panel), this reads
 * as one field among many and is the right control inside a params grid.
 */
export function SwitchField({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <label className={className !== undefined ? `switch-field ${className}` : "switch-field"} htmlFor={id}>
      <span className="switch-field-text">
        <span className="switch-field-title">{label}</span>
        {description !== undefined && <span className="switch-field-desc">{description}</span>}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="toggle-switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
