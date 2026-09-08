import type { ReactNode } from "react";

/** Page title row: h2 + optional trailing actions (refresh buttons, etc.). */
export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <h2>{title}</h2>
      {actions}
    </div>
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
