import type { ReactNode } from "react";

/**
 * The stock a sheet is run on. One per kind of sheet, so a School
 * Administrator knows which sheet is in front of them before reading a word.
 */
export type Stock = "goldenrod" | "blue" | "canary" | "pink" | "mint" | "buff";

/**
 * Every page is one sheet: the stock floods the frame, the head carries the
 * mark and which sheet this is, and the legend beside the record stays level
 * while the record scrolls.
 *
 * The legend explains the sheet's own marks and never names a record. A sheet
 * shown for a refusal carries no legend at all, so nothing about what exists
 * can be read off it (ADR-0002).
 */
export function Sheet({
  stock,
  name,
  legend,
  head,
  children,
}: {
  stock: Stock;
  name: string;
  legend?: ReactNode;
  head?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`sheet sheet--${stock}`}>
      <header className="sheet__head">
        <div className="sheet__group">
          <p className="sheet__mark">SchoolGrid</p>
          <p className="sheet__no">{name}</p>
        </div>
        {head}
      </header>
      <div className={legend === undefined ? "sheet__body sheet__body--single" : "sheet__body"}>
        {legend !== undefined && <aside className="legend">{legend}</aside>}
        <main className="run">{children}</main>
      </div>
      <footer className="sheet__foot">
        <p>End of sheet</p>
      </footer>
    </div>
  );
}

/** A sheet still coming off the drum. It names no record and no School. */
export function LoadingSheet({ stock, name }: { stock: Stock; name: string }) {
  return (
    <div className={`sheet sheet--${stock}`}>
      <header className="sheet__head">
        <div className="sheet__group">
          <p className="sheet__mark">SchoolGrid</p>
          <p className="sheet__no">{name}</p>
        </div>
      </header>
      <div className="sheet__body sheet__body--single">
        <main className="run" aria-busy="true" />
      </div>
      <footer className="sheet__foot">
        <p>End of sheet</p>
      </footer>
    </div>
  );
}

/** One entry in a sheet's legend: the mark, then what it means. */
export function Key({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}
