import type { ReactNode } from "react";

/**
 * A titled group of form fields — the standard way to break a long form into
 * scannable sections. Renders an optional heading + description, then the
 * children in a responsive field grid (`flow="grid"`, the default) or a plain
 * vertical stack (`flow="stack"`, for arbitrary content like a params form or
 * an action row). Pairs with `Field`.
 */
export function FormSection({
  title,
  description,
  columns,
  flow = "grid",
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Fixed desktop column count for `flow="grid"`; omit for an auto-fit grid. */
  columns?: 1 | 2 | 3;
  flow?: "grid" | "stack";
  children: ReactNode;
  className?: string;
}) {
  const body =
    flow === "stack"
      ? "form-section-body form-section-body-stack"
      : columns !== undefined
        ? `form-section-body form-section-body-${columns}`
        : "form-section-body";
  return (
    <section className={className !== undefined ? `form-section ${className}` : "form-section"}>
      {(title !== undefined || description !== undefined) && (
        <header className="form-section-head">
          {title !== undefined && <h4 className="form-section-title">{title}</h4>}
          {description !== undefined && <p className="form-section-desc">{description}</p>}
        </header>
      )}
      <div className={body}>{children}</div>
    </section>
  );
}
