import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * A compact icon control with a durable accessible name and hover/focus hint.
 * The one sanctioned icon button — screens must not hand-roll one.
 */
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
      data-tooltip={hint}
    >
      {children}
    </button>
  );
}
