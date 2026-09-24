import type { ReactNode } from "react";

/**
 * A wrapping toolbar for filters / inline actions. Keeps a row of controls
 * on a shared baseline with consistent gaps, instead of an ad-hoc flex line.
 */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className !== undefined ? `toolbar ${className}` : "toolbar"}>{children}</div>;
}
