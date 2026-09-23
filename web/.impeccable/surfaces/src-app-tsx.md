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

Superseded on 2026-09-23. The ditto-sheet world this brief built was retired by the whole-app redesign; these pages now inherit the School Report world recorded in `src-shell-tsx.md` through the shared tokens and controls. Each page gets its own brief and contract as it is redesigned. Owed by every one of them: the page title with its primary action on the same line, and a sweep of copy that still speaks the retired sheet metaphor ("the sheets that follow", "this sheet").

## Unresolved

Which page is redesigned next, and in what order.
