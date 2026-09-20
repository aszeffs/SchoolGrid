# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: **School staff** — Faculty recording attendance and results for their Class Offerings, and School Administrators configuring the School, managing Invitations and relationships, approving Correction requests, and investigating Audit records. They work on a school day, often mid-lesson or between them, on records that belong to real children.

Also served: **Students** reading their own published records, and **Guardians** reading one linked Student's records under a per-Student Access profile (attendance read and results read, granted independently).

Second audience, never at the cost of the first: **technical evaluators** — engineers and recruiters opening the public demo cold at <https://schoolgrid-phi.vercel.app> to judge the DevSecOps work behind it. Every screen is a working staff tool first and a portfolio exhibit second; each must read well to someone who arrives with no context, signs in through a one-click demo role, and leaves in two minutes.

## Product Purpose

SchoolGrid is a K-12 academic records system for a single School per boundary: enrollment, class offerings, attendance, results, publication, corrections, and audit. Success is that a Faculty member can record a day's attendance and a term's results without fighting the interface, a School Administrator can trace any change to who made it, and a Student or Guardian sees exactly what was published to them and nothing else.

## Positioning

The security properties live in the domain, not in a layer bolted on afterwards: every record belongs to exactly one School, access derives from scoped relationships rather than from credentials, and every refusal is the same **Safe denial** that leaks nothing about what exists. The pipeline that ships it matches that posture — production runs a signed, scanned, digest-pinned image that a fresh credential-less runner re-verifies as an outsider would (see `README.md` and `docs/adr/`).

## Operating Context

- Faculty record Attendance for a Roster snapshot on one School date, inside an Attendance window measured per School; after it closes, changes need a Correction request from a School Administrator.
- School dates are calendar dates in the School's own timezone; Instructional days are configured per Academic Year.
- Results are recorded against a Term and become visible to Students and Guardians only on Publication.
- School Administrators issue Invitations, delivered to the human personally, each redeemable once and revocable before redemption.
- The public demo carries invented data only, is open to anyone, and is dropped and reseeded nightly from `demo/seed.sql`. It runs on a Hobby plan that scales to zero, so the first request after a quiet spell is slow and the UI must survive that.

## Capabilities and Constraints

- Stack in place: React 19 + Vite + TypeScript SPA in `web/`, built into the service image and served on every path outside `/api` from the same origin. No router library, no component library, no CSS framework — `src/navigation.ts` and a single `src/styles.css` (~150 lines, light/dark custom properties).
- Shipped surfaces today: sign-in (with demo one-click roles), Schools list, Persons list, Invitations issue and redeem, "How this was built", and `NotAvailable`.
- Not yet built: every School-scoped academic surface — attendance sessions, results entry and publication, correction requests, audit review, enrollment and roster management, guardian and student views.
- **No inline code, enforced at build time.** The service's Content Security Policy allows only same-origin files: no inline `<script>`, no inline `<style>`, no `style=` attribute, no `on*=` handler, and no `data:` URL inlining. `vite.config.ts` fails the build on any of them. Styling goes in `src/styles.css` (or another emitted stylesheet); CSS-in-JS and inline style objects are not available.
- Development runs Vite on its own origin with `/api` proxied to the service on `:3000`, so the page and the API share one origin exactly as they do in the image.
- **Safe denial is a UI constraint, not only an API one.** `NotAvailable` is the single state for a refused request, a failed one, or a path that does not exist, and it must never explain which. No screen may infer or display a reason the API withheld (ADR-0002).
- Use the domain vocabulary in `CONTEXT.md` verbatim in UI copy — School Administrator not "admin", Faculty not "teacher", Class Offering not "class", Guardian not "parent", Enrollment not "registration". Each term there also lists the words to avoid.
- Undecided: whether the app stays router-less as academic surfaces land; whether a component library or design system is adopted.

## Brand Commitments

The name **SchoolGrid** is fixed. Nothing else is: no logo, no committed palette, no typeface. The current navy accent and light/dark tokens in `src/styles.css` are incumbent implementation, not a brand promise, and a later visual direction may replace them.

## Evidence on Hand

- `CONTEXT.md` — the authoritative domain vocabulary; UI copy derives from it.
- `docs/adr/` — recorded decisions, including ADR-0002 (safe denial) and ADR-0005 (production runs the verified image).
- `README.md` — the security pipeline, step by step, with what each step prevents.
- A live public demo with real deployment provenance on `/how-this-was-built` (commit and image digest, with the command to verify them).
- No real Student, Guardian, or School data exists anywhere, and none may be invented in UI copy, screenshots, or seeds. There are no customers, no testimonials, no benchmarks, and no pricing — do not fabricate any.

## Product Principles

1. **The refusal explains nothing.** One denial state, identical for absent, out-of-School, and forbidden. Helpfulness stops where disclosure begins.
2. **Staff-first, on a school day.** Design for someone mid-lesson with a roster in front of them, not for a leisurely browse.
3. **Speak the domain's words.** `CONTEXT.md` terminology is the copy standard; a synonym in the UI is a defect.
4. **Every change is traceable.** Anything that writes a record makes it obvious who is acting and what was recorded.
5. **Read well cold.** A stranger arriving at the demo should understand what they are looking at without being told.

## Accessibility & Inclusion

**WCAG 2.2 AA** is binding for all UI work: contrast, full keyboard paths, visible focus, correctly labelled controls, target sizes, and status messages announced to assistive technology. Guardians and Students span a wide range of devices and abilities; staff screens are used quickly and often, so keyboard-only operation is a requirement rather than a courtesy.
