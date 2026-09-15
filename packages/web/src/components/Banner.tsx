import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";

export type BannerTone = "info" | "success" | "warning" | "danger";

const ICONS: Record<BannerTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonAlert,
};

/**
 * An inline status/alert banner (overrides, errors, warnings). One visual
 * language for every "something you should know" strip.
 */
export function Banner({
  tone = "info",
  title,
  children,
  icon,
  className,
}: {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Override the tone glyph. */
  icon?: ReactNode;
  className?: string;
}) {
  const Glyph = ICONS[tone];
  return (
    <div className={`banner banner-${tone} ${className ?? ""}`.trim()} role={tone === "danger" ? "alert" : "status"}>
      <span className="banner-icon" aria-hidden="true">
        {icon ?? <Glyph size={15} />}
      </span>
      <div className="banner-body">
        {title !== undefined && <strong className="banner-title">{title}</strong>}
        {children !== undefined && <span className="banner-text">{children}</span>}
      </div>
    </div>
  );
}
