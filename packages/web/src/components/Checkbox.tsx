import { useId, type InputHTMLAttributes, type ReactNode } from "react";

/**
 * The shared checkbox. `label` makes the whole row clickable (a CheckboxRow);
 * omit it for a bare box (icon-only grids, table cells).
 */
export function Checkbox({
  label,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label?: ReactNode }) {
  const generated = useId();
  const id = props.id ?? generated;
  const input = <input {...props} id={id} type="checkbox" className="checkbox" />;
  if (label === undefined) return input;
  return (
    <label className={`checkbox-row ${className ?? ""}`.trim()} htmlFor={id}>
      {input}
      <span className="checkbox-label">{label}</span>
    </label>
  );
}
