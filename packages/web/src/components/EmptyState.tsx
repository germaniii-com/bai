import type { ReactNode } from "react";

/**
 * The shared empty/placeholder state: icon + title + optional description and
 * action, centered. Replaces the scattered `.dim "No X yet."` paragraphs.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state ${className ?? ""}`.trim()}>
      {icon !== undefined && (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <p className="empty-state-title">{title}</p>
      {description !== undefined && <p className="empty-state-desc">{description}</p>}
      {action !== undefined && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
