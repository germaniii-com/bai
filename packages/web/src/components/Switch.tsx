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
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Inline label beside the switch (also the accessible name). */
  label?: ReactNode;
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
        onChange={(e) => onChange(e.target.checked)}
      />
      {label !== undefined && <span className="switch-label">{label}</span>}
    </label>
  );
}
