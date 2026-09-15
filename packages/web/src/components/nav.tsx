import type { ReactNode } from "react";

/**
 * Navigation components. These wrap the app's established rail/subnav class
 * names (.master-item, .settings-nav, .provider-item, .new-session) so the
 * existing responsive rules in styles.css (rail → top row, subnav →
 * horizontal strip on ≤640px) keep working unchanged — the components
 * enforce the structure, the CSS stays the single source of truth.
 */

/**
 * Master-rail item (icon-only, optional badge, disabled state).
 *
 * The rail shows icons alone; the label is the accessible name and the
 * hover/focus hint (the global `[data-tooltip]` layer in tooltip.tsx).
 */
export function NavItem({
  icon,
  label,
  active = false,
  disabled = false,
  badge = 0,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  /** Pending-count badge (0 = hidden). */
  badge?: number;
  onClick?: () => void;
}) {
  const className = active && !disabled ? "master-item active" : "master-item";
  if (disabled) {
    return (
      <button
        type="button"
        className={className}
        disabled
        aria-label={`${label} — coming in a later phase`}
        data-tooltip={`${label} — coming in a later phase`}
        data-tooltip-placement="right"
      >
        {icon}
      </button>
    );
  }
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      data-tooltip={label}
      data-tooltip-placement="right"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      {badge > 0 && (
        <span className="nav-badge" aria-label={`${badge} pending ask${badge === 1 ? "" : "s"}`}>
          {badge}
        </span>
      )}
    </button>
  );
}

/** The nested-panel list container (vertical on desktop, scroll strip on mobile). */
export function SubNav({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className !== undefined ? `settings-nav ${className}` : "settings-nav"}>{children}</div>;
}

/** Nested-panel item: title + dim subtitle + optional trailing check. */
export function SubNavItem({
  title,
  subtitle,
  trailing,
  selected = false,
  onClick,
  ariaCurrent,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Top-right slot (e.g. the connected check). */
  trailing?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  ariaCurrent?: "page";
}) {
  return (
    <button
      type="button"
      className={selected ? "provider-item active" : "provider-item"}
      onClick={onClick}
      aria-current={ariaCurrent}
    >
      <span className="title">{title}</span>
      {subtitle !== undefined && <span className="dim">{subtitle}</span>}
      {trailing}
    </button>
  );
}

/** The "+ new …" create button at the top of a subnav. */
export function SubNavCreate({
  label,
  disabled = false,
  onClick,
  className,
}: {
  label: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const classes = className !== undefined ? `new-session ${className}` : "new-session";
  return (
    <button type="button" className={classes} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}
