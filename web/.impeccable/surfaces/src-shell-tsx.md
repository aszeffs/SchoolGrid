---
version: 1
slug: "src-shell-tsx"
primary_target: "src/Shell.tsx"
related_targets: ["src/Sheet.tsx","src/ShellContext.ts","src/Link.tsx","src/styles.css"]
---

## Scope

The School shell and every shared primitive: the frame every signed-in page renders inside (app bar, section sidebar, School switcher, sign-out, the page frame `Sheet` draws), plus the global tokens and base controls in `src/styles.css` that every screen inherits. First surface of a whole-app restyle (spec #207, slice #208) that replaces the "School Report" world. Visitor mode: **Operate**.

## Audience and task

Faculty and School Administrators on a school day, between lessons: know which School, who they act as, where they are, and reach the next section in one move. Evaluators opening a Trial School cold must read it as a current SaaS product at Stripe Dashboard / Notion craft. Binding: `CONTEXT.md` vocabulary verbatim, Safe denial, CSP (no inline style/script/handler, fonts self-hosted), WCAG 2.2 AA in both renditions, light/dark follow the browser (ADR-0010), no component library (ADR-0006). Pinned by owner: Atkinson Hyperlegible stays; comfortable density (44px controls, 56px roster rows). Owner rejected the previous look as too plain, dated in layout, flat, and unable to follow a SaaS landing page.

## Direction contract

THESIS: The School's week, pinned in the staff room: every Class Offering owns a colour, and the app is read like a timetable wall chart. It refuses both the colourless "official record" it replaces and the anonymous grey-card admin panel.

OWN-WORLD: White (light) or deep ink (dark) ground in white-guttered blocks. A six-hue categorical set (indigo, amber, teal, orange, rose, violet), assigned to Courses so a Class Offering keeps its colour everywhere: its block, its chip, its column edge. Indigo is also the action colour. Blocks are softly rounded (10px) with one quiet shadow step; tables inside are ruled and neutral. Atkinson Hyperlegible Next, bold condensed-feeling headings via weight and tracking, tabular figures.

STORY: Staff see their School and their week at a glance, find a Class Offering by its colour, act, and move on. Evaluators see a polished, colourful, credible product.

FIRST VIEWPORT: Left sidebar (School switcher at top, sections grouped People / Academic / School, current section a filled indigo-tinted row), app bar with page title, a primary action at right of the title line, a strip of colour-keyed summary blocks (counts in large tabular figures), then a ruled record table where each Class Offering row carries its course colour on its leading edge. Signature interaction: hovering or focusing a Course anywhere lights every block of that colour on the page.

FORM: Timetable Wall Chart, candidate 1 of seven grounded directions, chosen as the pick card over the roll. Seed key 141c5e00.

RAISES: From Japanese high-density web: every module headed by a small coloured tab. From Nixie counter: counts own their space in large tabular figures. From Industrial quote grammar: ended records take a diagonal hatch. From Iridescent cloud edge: reading text stays on neutral ground. From Vertical feed: a Dialog owns the viewport. From Cracktro: one systematic state scale (filled, ringed, hatched).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Course colour assignment rule (stable hash of Course id vs chosen by School Administrator) — decide in the build.
