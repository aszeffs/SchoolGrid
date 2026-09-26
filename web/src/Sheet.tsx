import type { ReactNode } from "react";
import { useShell } from "./ShellContext.ts";

/** Which page this is: the name it carries while its record is still being read. */
export interface SheetKind {
  name: string;
}

/**
 * Every page is one sheet of the record. Inside a School the shell's header is a
 * sidebar holding the School, its sections and who is acting, and the sheet runs
 * beside it; anywhere else the header is a bar across the top. The key beside
 * the record stays level while the record scrolls.
 *
 * The key explains the page's own marks and never names a record. A sheet
 * shown for a refusal carries no key at all, so nothing about what exists
 * can be read off it (ADR-0002).
 *
 * A sheet still being read is the same sheet with `busy` set: it names no
 * record. Inside the shell it keeps the shell's header and navigation, which
 * the session had already settled before the sheet was asked for.
 */
export function Sheet({
  name,
  legend,
  head,
  foot,
  busy = false,
  children,
}: SheetKind & {
  legend?: ReactNode;
  /** In the header, after the shell's own. Left off while the sheet is still being read. */
  head?: ReactNode;
  /** The way off this page, ruled off below the record. */
  foot?: ReactNode;
  busy?: boolean;
  children?: ReactNode;
}) {
  const shell = useShell();
  const aside = busy ? undefined : legend;
  const inSchool = shell?.nav !== undefined;
  return (
    <div className={inSchool ? "sheet sheet--school" : "sheet"}>
      <header className="sheet__head">
        <div className="sheet__group">
          <p className="sheet__mark">SchoolGrid</p>
          {/* Inside a School the current section names the page; nowhere else does. */}
          {!inSchool && <p className="sheet__no">{name}</p>}
        </div>
        {shell?.head}
        {shell?.nav}
        {!busy && head}
        {shell?.foot}
      </header>
      <div className="sheet__main">
        {shell?.banner}
        <div className={aside === undefined ? "sheet__body sheet__body--single" : "sheet__body"}>
          <main className="run" aria-busy={busy || undefined}>
            {!busy && children}
            {!busy && foot !== undefined && <div className="foot">{foot}</div>}
          </main>
          {aside !== undefined && <aside className="legend">{aside}</aside>}
        </div>
      </div>
    </div>
  );
}

/** One entry in a page's key: the mark, then what it means. */
export function Key({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}
