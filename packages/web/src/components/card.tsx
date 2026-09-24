import type { HTMLAttributes, ReactNode } from "react";

/**
 * The one card surface (settings cards, provider cards, KPI cards, chart
 * cards). Bordered panel, token padding, column layout. Extra variants via
 * className (e.g. "connected"). `as="form"` turns the card into a form
 * (submit-on-Enter works; the submit handler rides the same props).
 */
export function Card({
  as = "div",
  variant = "default",
  padding = "md",
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  as?: "div" | "form" | "section";
  /** `raised` adds a soft surface lift (--shadow-card). */
  variant?: "default" | "raised";
  /** Card padding: sm (8), md (16), lg (20). */
  padding?: "sm" | "md" | "lg";
}) {
  const classes = [
    "card",
    variant === "raised" ? "card-raised" : "",
    padding !== "md" ? `card-pad-${padding}` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const Tag = as as "div";
  return (
    <Tag className={classes} {...props}>
      {children}
    </Tag>
  );
}
