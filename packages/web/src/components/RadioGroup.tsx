import { useId, type ReactNode } from "react";

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

/**
 * The shared radio group (question options, single-choice settings). Renders
 * a labelled listbox of radios; the whole row is clickable.
 */
export function RadioGroup({
  value,
  onChange,
  options,
  name,
  ariaLabel,
  orientation = "vertical",
  className,
}: {
  value: string | null;
  onChange: (value: string) => void;
  options: RadioOption[];
  name?: string;
  ariaLabel?: string;
  orientation?: "vertical" | "horizontal";
  className?: string;
}) {
  const generated = useId();
  const groupName = name ?? generated;
  return (
    <div
      className={`radio-group radio-${orientation} ${className ?? ""}`.trim()}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <label
          key={opt.value}
          className={`radio-row${opt.disabled === true ? " disabled" : ""}`}
        >
          <input
            type="radio"
            className="radio"
            name={groupName}
            value={opt.value}
            checked={value === opt.value}
            disabled={opt.disabled}
            onChange={() => onChange(opt.value)}
          />
          <span className="radio-text">
            <span className="radio-label">{opt.label}</span>
            {opt.description !== undefined && (
              <span className="radio-desc">{opt.description}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}
