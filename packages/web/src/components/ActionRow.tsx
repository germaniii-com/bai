import type { ReactNode } from "react";

/**
 * The one form action row: a wrapping flex row of buttons. `align="end"`
 * (default) right-aligns the primary action, `"between"` splits leading
 * secondary actions from trailing primary ones, `"start"` left-aligns.
 * On phones the buttons stretch full width (same behaviour as the old
 * `.agents-actions` rule).
 */
export function ActionRow({
  align = "end",
  children,
  className,
}: {
  align?: "start" | "end" | "between";
  children: ReactNode;
  className?: string;
}) {
  const classes = ["action-row", `action-row-${align}`, className].filter(Boolean).join(" ");
  return <div className={classes}>{children}</div>;
}
