import type { ReactNode } from "react";
import { PanelRight } from "lucide-react";

/**
 * Navigation components. These wrap the app's established rail/subnav class
 * names (.master-item, .settings-nav, .provider-item, .new-session) so the
 * existing responsive rules in styles.css keep working — the components
 * enforce the structure, the CSS stays the single source of truth.
 *
 * On ≤640px the nested panel is not a horizontal strip: it lives in a
 * right-edge Drawer opened from MasterNav's section-menu toggle
 * (App.tsx `useMediaQuery` + `subnavOpen`).
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

/**
 * Right-edge section-menu toggle (MasterNav, opposite the brand mark).
 * Opens the mobile subnav Drawer; CSS hides it above 640px. Rendered after
 * a `.nav-divider` so the | sits between the scroll region and the control.
 */
export function SubNavToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="subnav-toggle-group">
      <div className="nav-divider" role="separator" aria-label="section menu" />
      <button
        type="button"
        className="master-item subnav-toggle"
        aria-label={open ? "Close section menu" : "Open section menu"}
        aria-expanded={open}
        data-tooltip="Section menu"
        data-tooltip-placement="left"
        onClick={onToggle}
      >
        <PanelRight className="nav-icon" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The nested-panel list container (vertical column; Drawer body on phones). */
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

/** The "+ new …" / action button at the top of a subnav. */
export function SubNavCreate({
  label,
  icon,
  disabled = false,
  onClick,
  className,
  ariaPressed,
}: {
  label: ReactNode;
  /** Leading glyph (e.g. the compose / search icons on the sidebar actions). */
  icon?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  /** Toggle semantics for a button that reveals something (search). */
  ariaPressed?: boolean;
}) {
  const classes = className !== undefined ? `new-session ${className}` : "new-session";
  return (
    <button type="button" className={classes} disabled={disabled} onClick={onClick} aria-pressed={ariaPressed}>
      {icon !== undefined && (
        <span className="new-session-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {label}
    </button>
  );
}
