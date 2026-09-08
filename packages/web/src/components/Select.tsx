import { ChevronDown } from "lucide-react";
import type { ChangeEvent } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Styled native select — for SHORT, static option lists (date ranges, call
 * kinds). Dynamic/long lists must use the Combobox (type-to-search) or a
 * picker Modal instead. Heights come from --control-h-md, matching Button
 * and TextInput exactly.
 */
export function Select({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
  className,
}: {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const handle = (e: ChangeEvent<HTMLSelectElement>): void => onChange(e.target.value);
  return (
    <span className={className !== undefined ? `select ${className}` : "select"}>
      <select value={value} onChange={handle} aria-label={ariaLabel} disabled={disabled}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="select-caret" aria-hidden="true">
        <ChevronDown size={14} />
      </span>
    </span>
  );
}
