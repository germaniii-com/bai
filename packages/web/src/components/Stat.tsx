import type { ReactNode } from "react";

/** A label + value pair (model info, run telemetry, KPI lines). */
export function Stat({
  label,
  value,
  tone = "default",
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "default" | "success" | "danger" | "warning" | "accent";
}) {
  return (
    <span className={tone === "default" ? "stat" : `stat stat-${tone}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </span>
  );
}

/** A wrapping row of `Stat`s. */
export function StatRow({
  children,
  className,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      className={className !== undefined ? `stat-row ${className}` : "stat-row"}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}
