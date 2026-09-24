import type { ReactNode } from "react";

/** Page title row: icon + h2 + optional lede + optional trailing actions. */
export function PageHeader({
  title,
  lede,
  icon,
  actions,
}: {
  title: ReactNode;
  lede?: ReactNode;
  /** Leading glyph beside the title (e.g. the Learn form's cap). */
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <>
      <div className="page-header">
        {icon !== undefined && (
          <span className="page-header-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <h2>{title}</h2>
        {actions}
      </div>
      {lede !== undefined && <p className="section-lede">{lede}</p>}
    </>
  );
}

/** Section heading: h3 + optional dim lede paragraph (the established pattern). */
export function SectionHeader({ title, lede }: { title: ReactNode; lede?: ReactNode }) {
  return (
    <>
      <div className="section-header">
        <h3>{title}</h3>
      </div>
      {lede !== undefined && <p className="section-lede">{lede}</p>}
    </>
  );
}
