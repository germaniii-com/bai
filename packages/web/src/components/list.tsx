import type { ReactNode } from "react";

/**
 * The universal list row — one visual language for nav rows (sessions,
 * workspace items), picker rows (model/agent modals), and inline rows
 * (explorer/tree). Title + optional subtitle + optional icon + trailing
 * slot (check/badge). Selection: background, plus the nav-style inset
 * accent bar when `accentBar` is set.
 *
 * The HTML `title` tooltip attribute is intentionally omitted from props —
 * pass `hint` if a native tooltip is needed.
 */
export function ListItem({
  title,
  subtitle,
  icon,
  trailing,
  selected = false,
  accentBar = false,
  inline = false,
  disabled = false,
  onClick,
  hint,
  className,
  ariaCurrent,
  ...rest
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Top-right slot (check mark, badge). Absolute when stacked, in-flow when inline. */
  trailing?: ReactNode;
  selected?: boolean;
  /** Nav-style inset accent bar when selected (sessions, workspace items). */
  accentBar?: boolean;
  /** Single-row layout (explorer/tree style) instead of stacked. */
  inline?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Native tooltip (e.g. a full path on a truncated row). */
  hint?: string;
  className?: string;
  ariaCurrent?: "page";
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title" | "onClick" | "className" | "disabled">) {
  const classes = [
    "list-item",
    inline ? "inline" : "",
    selected ? "selected" : "",
    accentBar ? "accent-bar" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      disabled={disabled}
      onClick={onClick}
      aria-current={ariaCurrent}
      title={hint}
      {...rest}
    >
      <span className="li-head">
        {icon !== undefined && (
          <span className="li-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="li-title">{title}</span>
        {inline && trailing !== undefined && <span className="li-trailing">{trailing}</span>}
      </span>
      {subtitle !== undefined && <span className="li-sub">{subtitle}</span>}
      {!inline && trailing !== undefined && <span className="li-trailing">{trailing}</span>}
    </button>
  );
}
