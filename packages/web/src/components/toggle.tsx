import type { ReactNode } from "react";

/**
 * A full-row checkbox toggle (the settings pattern): checkbox + title +
 * dim description. The whole row is the label, so clicking anywhere flips.
 */
export function ToggleRow({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-title">{title}</span>
      {description !== undefined && <span className="toggle-desc">{description}</span>}
    </label>
  );
}
