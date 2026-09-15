import type { InputHTMLAttributes } from "react";

/** The shared color picker (custom-theme palette editor). */
export function ColorInput({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input {...props} type="color" className={`color-input ${className ?? ""}`.trim()} />;
}
