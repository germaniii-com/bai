import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";

/**
 * The shared data table. `Table` is the scroll container + styled table; use
 * native `<thead>/<tbody>/<tr>` with the `Th`/`Td` cells.
 */
export function Table({ children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={`table-wrap ${className ?? ""}`.trim()} {...rest}>
      <table className="table">{children}</table>
    </div>
  );
}

export function Th({ children, className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={`table-th ${className ?? ""}`.trim()} {...rest}>
      {children}
    </th>
  );
}

export function Td({ children, className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`table-td ${className ?? ""}`.trim()} {...rest}>
      {children}
    </td>
  );
}
