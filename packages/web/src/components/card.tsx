import type { HTMLAttributes, ReactNode } from "react";

/**
 * The one card surface (settings cards, provider cards, KPI cards, chart
 * cards). Bordered panel, token padding, column layout. Extra variants via
 * className (e.g. "connected"). `as="form"` turns the card into a form
 * (submit-on-Enter works; the submit handler rides the same props).
 */
export function Card({
  as = "div",
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { children: ReactNode; as?: "div" | "form" | "section" }) {
  const classes = className !== undefined ? `card ${className}` : "card";
  const Tag = as as "div";
  return (
    <Tag className={classes} {...props}>
      {children}
    </Tag>
  );
}
