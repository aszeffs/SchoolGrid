---
version: 1
slug: "src-shell-tsx"
primary_target: "src/Shell.tsx"
related_targets: ["src/Sheet.tsx","src/ShellContext.ts","src/Link.tsx","src/styles.css"]
---

## Scope

The School shell: the frame every signed-in page renders inside (report header, section tabs, School switcher, sign-out, the page frame `Sheet` draws), plus the global tokens and base controls in `src/styles.css` that every screen inherits. First surface of a whole-app redesign that replaces the ditto-sheet world; the screens inside the shell are restyled only as far as the shared tokens and controls carry them. Visitor mode: **Operate**.

## Audience and task

Faculty and School Administrators on a school day, often between lessons: know which School, who they are acting as, and where they are, then reach the next section in one move. Evaluators opening the demo cold must read the same thing in seconds. Binding: `CONTEXT.md` vocabulary verbatim, Safe denial (`NotAvailable` explains nothing), CSP (no inline style, script or handler; fonts self-hosted), WCAG 2.2 AA, light and dark renditions following the system setting (supersedes ADR-0009). User rejected: theme costumes, cramped density, eye strain.

## Direction contract

THESIS: Every screen reads as an official school record: whom it concerns, who is acting, what was recorded, in that order. It refuses the portal default (white cards on grey behind a left rail) and any themed costume, including the ditto sheet it replaces.

OWN-WORLD: A calm achromatic reading field, cool near-white in light and deep slate in dark, with one seal blue for action and marks; colour lives only in hairline edges and seal marks. One hyperlegible sans throughout, tabular figures in strict columns. Ruled sections, no shadows, no floating cards, no pills. State is a word plus a seal mark (filled, ringed, struck), never colour alone.

STORY: Staff see which School, who they act as, and where they are within seconds; trust the record because it names its actor; act and move on.

FIRST VIEWPORT: A report header band across the full width: School name large at left, beneath it "Signed in as <name>" with their roles as small seal-edged labels; School switcher and Sign out at right. Under it, the School's sections as a row of report-page tabs, the current one lifted onto the page with a seal-blue top edge while its siblings stay visible. Then the page title with its primary action at the right of the same line, and the record in a wide ruled column below. Signature interaction: moving between sections slides the seal edge to the new tab while the reading plane stays still.

FORM: School Report, candidate 4 of seven grounded directions, assigned by the roll after one re-roll. Seed key 41e95cfa.

RAISES: From Iridescent Cloud Edge: colour confined to hairline edges; the reading field stays calm. From Phosphor Terminal: state prints itself into the record as words and marks. From Datamatics: tabular figures in strict columns. From Star Atlas: emphasis on one fixed ramp. From Midnight Transit: the current section leads while siblings stay visible. From Miura Fold: on a phone one section unfolds at a time.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Recorded deviations

- Page title with its primary action on one line: owed by every screen, not by the shell. The shell ships the frame; each screen brief must carry it when that screen is redesigned (Persons today puts "Add Person" well below its title).
- On a phone, "one section unfolds at a time" ships as ruled rows of sections, three to a row and edge to edge, with the key moved below the record. A fold that hides sections was declined: the browser suite requires every section to be reachable in the first screen at 360px.
- State colour: one seal blue carries every mark (filled, ringed); struck marks are soft ink. `--alarm` red is the one sanctioned exception, for errors and actions that take something away.

## Unresolved

Whether a manual light/dark override is wanted beyond the system setting.
