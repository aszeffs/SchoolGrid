---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/SignIn.tsx","src/Schools.tsx","src/Persons.tsx","src/Invitations.tsx","src/RedeemInvitation.tsx","src/HowThisWasBuilt.tsx","src/NotAvailable.tsx","src/styles.css"]
---

## Scope

Every shipped page of the SchoolGrid web app, rebuilt under one replacement visual world: sign-in (with demo roles), Schools, Persons, issued-invitation link, pending invitations, redeem invitation, How this was built, Not available. Visitor mode: **Operate**, with How this was built inheriting the world as a Read page.

## Audience and task

School staff first: Faculty and School Administrators working mid-lesson or between them, on records belonging to real children. Evaluators arriving cold at the public demo are the second audience, served by the same screens rather than by separate marketing. Constraints that outrank expression: `CONTEXT.md` vocabulary verbatim, Safe denial (one `NotAvailable` state that never explains itself), no inline styles or handlers of any kind (CSP, build-enforced), WCAG 2.2 AA.

## Direction contract

THESIS: SchoolGrid is the school office's own printing press. Every screen is a run off the drum — violet aniline ink struck onto coloured copy stock — and it refuses the arrangement every school portal ships: white cards floating on a grey page behind a left nav rail. The record is the page, not cargo inside a container on the page.

OWN-WORLD: Aniline violet ink (#3B2A6B) as the only ink, on saturated pastel copy stock that floods the entire frame — the spirit duplicator's own copy-stock family, all six of it: goldenrod, canary, blue, pink, mint and buff, one stock per context, never a white panel on grey and never a cream or grey ground, which are not stocks in this family and are the light ground this world exists to refuse. Typewriter strike for data and figures, stencil caps for heads, violet hairlines for every rule. Registration marks, run numbers, and a stapled corner are chrome; shadows, gradients, and rounded cards do not exist. Recognizable with all content removed by the flooded stock, the hairline rules, and the struck caps.

STORY: The visitor understands that this is a school's own record sheet rather than a product's dashboard; believes the record is authoritative because it looks struck rather than rendered; and acts by reading a roster, marking or issuing, and moving on.

FIRST VIEWPORT: Goldenrod stock edge to edge, no margin and no card. The School name struck in violet typewriter caps across the head with the run number small at the right. Beneath it, the code legend held level in a left strip that never scrolls. The roster ruled in violet hairlines fills the remaining width, with the status column hard right. The primary action sits at the foot of the sheet where a form's action sits on paper, not floating top-right.

FORM: The Ditto Sheet, candidate 6 of seven grounded directions, assigned by the roll. Seed key 9786ddba.

RAISES: From Phosphor Terminal — keyboard-first operation, and state prints itself into the record rather than appearing as chrome. From Yé-Yé Pop Sleeve — total colour commitment: the stock floods the whole frame. From Gravity-Rain Garden — one legend held level, permanent and never scrolling away from the record it explains. From Drawcord Cape — every change is a named, comparable state rather than an invisible mutation.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Recorded deviations

FIRST VIEWPORT asks for a run number small at the right of the head. The build does not ship one and will not: any run figure this app could print would be invented, and a records system that prints invented figures in the same hand as its records teaches its staff to trust decoration. The slot carries the School's name instead, struck in typewriter caps, while the sheet's own name sits left beside the wordmark; the world's other two chrome devices — the registration mark and the stapled corner — were built in full. Raised at the finish review, declined on truth grounds, not on cost.

## Unresolved

Whether the app stays router-less as academic surfaces land. Exact stock-per-context assignment beyond the first three pages.
