import { useState, type ReactNode } from "react";

/**
 * A labeled section/panel that expands and collapses with an animated height
 * (grid-template-rows 0fr↔1fr) and a rotating chevron. Replaces the three
 * copy-pasted rail panel headers and the chat's thinking/tool disclosures.
 */
export function Disclosure({
  title,
  count,
  icon,
  trailing,
  open,
  defaultOpen = true,
  onOpenChange,
  children,
  id,
  className,
  headClassName,
  variant = "panel",
  disabled = false,
}: {
  title: ReactNode;
  /** Optional trailing count (e.g. "3/5"). */
  count?: ReactNode;
  icon?: ReactNode;
  /** Extra node before the chevron. */
  trailing?: ReactNode;
  /** Controlled open state (omit for uncontrolled). */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  /** id of the body, for aria-controls. */
  id?: string;
  className?: string;
  headClassName?: string;
  /** "panel" is the rail-header look; "inline" is a quiet text disclosure. */
  variant?: "panel" | "inline";
  disabled?: boolean;
}) {
  const [internal, setInternal] = useState(defaultOpen);
  const isOpen = open ?? internal;

  const toggle = (): void => {
    if (disabled) return;
    const next = !isOpen;
    if (open === undefined) setInternal(next);
    onOpenChange?.(next);
  };

  return (
    <section className={`disclosure disclosure-${variant} ${className ?? ""}`.trim()}>
      <button
        type="button"
        className={`disclosure-head ${headClassName ?? ""}`.trim()}
        aria-expanded={isOpen}
        aria-controls={id}
        disabled={disabled}
        onClick={toggle}
      >
        {icon !== undefined && (
          <span className="disclosure-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="disclosure-title">{title}</span>
        {count !== undefined && <span className="disclosure-count">{count}</span>}
        {trailing}
        <span className="disclosure-chevron" aria-hidden="true">
          <svg
            data-open={isOpen ? "true" : "false"}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      <div id={id} className="disclosure-body" data-open={isOpen ? "true" : "false"}>
        <div className="disclosure-inner">{children}</div>
      </div>
    </section>
  );
}
