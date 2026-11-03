import { Table as FlowbiteTable, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from 'flowbite-react';
import type { ReactNode } from 'react';

export interface Column<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Body text in the primary colour rather than the muted one. */
  primary?: boolean;
  className?: string;
}

/** The one data table: a Flowbite Table on the panel colours, with a quiet header and hairline rows. */
export function DataTable<Row>({ columns, rows, rowKey, onRowClick, empty, label }: {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  empty?: ReactNode;
  label: string;
}): ReactNode {
  if (rows.length === 0 && empty) return <div className="rounded-[var(--radius-control)] border border-dashed border-[color:var(--border)] p-2.5 text-center text-xs text-[var(--text-dim)]">{empty}</div>;
  return (
    <FlowbiteTable hoverable={Boolean(onRowClick)} aria-label={label}>
      <TableHead>
        <TableRow>{columns.map((column) => <TableHeadCell key={column.key} className={column.className}>{column.header}</TableHeadCell>)}</TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={rowKey(row)} className={onRowClick ? 'cursor-pointer' : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
            {columns.map((column) => <TableCell key={column.key} className={`${column.primary ? 'text-[var(--text)]' : ''} ${column.className ?? ''}`.trim()}>{column.cell(row)}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </FlowbiteTable>
  );
}
