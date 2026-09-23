import type { ReactNode } from "react";
import { useShell } from "./ShellContext.ts";

/**
 * The stock a sheet is run on. One per kind of sheet, so a School
 * Administrator knows which sheet is in front of them before reading a word.
 */
export type Stock = "goldenrod" | "blue" | "canary" | "pink" | "mint" | "buff" | "salmon";

/** Which sheet this is: the stock it runs on and the name struck in its head. */
export interface SheetKind {
  stock: Stock;
  name: string;
}

/**
 * Every page is one sheet: the stock floods the frame, the head carries the
 * mark and which sheet this is, and the legend beside the record stays level
 * while the record scrolls.
 *
 * The legend explains the sheet's own marks and never names a record. A sheet
 * shown for a refusal carries no legend at all, so nothing about what exists
 * can be read off it (ADR-0002).
 *
 * A sheet still coming off the drum is the same sheet with `busy` set: it
 * names no record. Inside the shell it keeps the shell's head and navigation,
 * which the session had already settled before the sheet was asked for.
 */
export function Sheet({
  stock,
  name,
  legend,
  head,
  foot,
  busy = false,
  children,
}: SheetKind & {
  legend?: ReactNode;
  /** Beside the mark in the head, after the shell's own. Left off while the sheet is still printing. */
  head?: ReactNode;
  /** The way off this sheet, ruled off below the record. */
  foot?: ReactNode;
  busy?: boolean;
  children?: ReactNode;
}) {
  const shell = useShell();
  const aside = busy ? undefined : legend;
  return (
    <div className={`sheet sheet--${stock}`}>
      <header className="sheet__head">
        <div className="sheet__group">
          <p className="sheet__mark">SchoolGrid</p>
          <p className="sheet__no">{name}</p>
        </div>
        {shell?.head}
        {!busy && head}
      </header>
      {shell?.nav}
      <div className={aside === undefined ? "sheet__body sheet__body--single" : "sheet__body"}>
        {aside !== undefined && <aside className="legend">{aside}</aside>}
        <main className="run" aria-busy={busy || undefined}>
          {!busy && children}
          {!busy && foot !== undefined && <div className="foot">{foot}</div>}
        </main>
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
