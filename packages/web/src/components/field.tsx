import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

/**
 * Form field wrapper: label + optional hint + control + optional error.
 * The label wraps the control, so clicking it focuses the input. Hints render
 * inline after the label (the app's established "(…)" pattern).
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={className !== undefined ? `field ${className}` : "field"}>
      <span className="field-label">
        {label}
        {hint !== undefined && <span className="field-hint"> {hint}</span>}
      </span>
      {children}
      {error != null && error.length > 0 && <span className="field-error">{error}</span>}
    </label>
  );
}

/** The shared text input skin (heights from --control-h-*, matching Button). */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function TextInput({ className, mono, ...props }, ref) {
    const classes = ["input", mono === true ? "mono" : "", className].filter(Boolean).join(" ");
    return <input ref={ref} className={classes} {...props} />;
  },
);

/** The shared textarea skin (vertical resize, token padding). */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, ...props }, ref) {
    const classes = ["input", mono === true ? "mono" : "", className].filter(Boolean).join(" ");
    return <textarea ref={ref} className={classes} {...props} />;
  },
);
