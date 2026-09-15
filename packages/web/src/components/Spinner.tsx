import type { HTMLAttributes } from "react";
import { LoaderCircle } from "lucide-react";

/**
 * The shared spinner (loading button slot, job cards, async panels). Rotation
 * is frozen by the global reduced-motion guard.
 */
export function Spinner({
  size = 14,
  className = "",
  ...rest
}: { size?: number } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`spinner ${className}`.trim()} role="status" aria-label="Loading" {...rest}>
      <LoaderCircle size={size} aria-hidden="true" />
    </span>
  );
}

/**
 * A shimmering placeholder block for content that is loading. Decorative —
 * hidden from assistive tech (the surrounding region conveys status).
 */
export function Skeleton({
  width,
  height = 12,
  radius = "var(--radius-control)",
  className = "",
}: {
  width?: string | number;
  height?: string | number;
  radius?: string;
  className?: string;
}) {
  return (
    <span
      className={`skeleton ${className}`.trim()}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius }}
    />
  );
}
