import { forwardRef, type ButtonHTMLAttributes } from "react";

/** The five button variants (the only allowed button looks). */
export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";

/** The three button sizes — heights come from the --control-h-* tokens, so a
 * Button is always exactly as tall as the TextInput beside it. */
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button while true. */
  loading?: boolean;
}

/**
 * The unified button. Labels are sentence case at call sites ("Save",
 * "Add account", "+ New agent") — the component renders children verbatim.
 *
 * Defaults: variant "secondary" (bordered panel), size "md". Primary is for
 * the one main action of a surface; danger for destructive; ghost for quiet
 * inline actions; outline for neutral actions on panel backgrounds.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, disabled, className, children, type, ...props },
  ref,
) {
  const classes = ["btn", `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(" ");
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
});
