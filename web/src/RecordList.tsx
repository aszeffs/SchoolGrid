import type { ReactNode } from "react";

/** One column of a record list: the term struck above it, and what it holds. */
export interface Column<Row> {
  /**
   * The column's head. It labels the value in every rendition — struck once
   * above the column on a wide sheet, and again beside each value once the
   * columns stack — so it reads as a term, not as a sentence.
   */
  head: string;
  cell: (row: Row) => ReactNode;
  /**
   * A column of actions rather than of record values. Its head is struck for
   * a screen reader but never printed, since a column of buttons that name
   * themselves does not need naming twice.
   */
  actions?: boolean;
}

/**
 * A record of several columns, ruled like the rest of the sheet.
 *
 * One `<table>` carries both renditions. Above the sheet's one breakpoint it
 * is a table, with the terms struck across the head. Below it the columns
 * stack: each row becomes an entry ruled off from the next, and each value is
 * struck under its own term, so a record that would not fit 360px is read down
 * rather than scrolled across. The table's own head is dropped there, because
 * each value already carries it.
 *
 * `roster` remains the primitive for the sheet's flat name-and-mark line. This
 * one is for a record that has more than one thing to say about each row.
 */
export function RecordList<Row>({
  label,
  columns,
  rows,
  keyOf,
  empty,
}: {
  /** What this record lists, named for a screen reader. */
  label: string;
  columns: Column<Row>[];
  rows: Row[];
  keyOf: (row: Row) => string;
  /** What the sheet says where the record has no rows. */
  empty: ReactNode;
}) {
  if (rows.length === 0) {
    return <p className="empty">{empty}</p>;
  }
  return (
    <table className="record" aria-label={label}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.head} scope="col">
              <span className={column.actions === true ? "unprinted" : undefined}>{column.head}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={keyOf(row)}>
            {columns.map((column) => (
              <td key={column.head} data-head={column.actions === true ? undefined : column.head}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
