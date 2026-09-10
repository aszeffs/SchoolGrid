# 04: CodeQL static analysis

**What to build:** Static analysis of the application code on every pull request and on a weekly schedule, with findings landing in the repository's Security tab.

There is currently no static analysis at all. The weekly run matters as much as the pull request run: CodeQL's rules improve over time, and a scheduled scan finds old bugs with new rules in code nobody has changed.

**Blocked by:** None (can start immediately).

**Status:** in-progress

- [x] A CodeQL workflow analyses JavaScript/TypeScript on pull requests to `dev` and `main`, and weekly.
- [ ] Results upload to code scanning and appear in the Security tab.
- [x] The workflow declares least-privilege permissions, widening only where CodeQL requires it.
- [x] Actions are SHA-pinned in the same style as ticket 01.
- [ ] A run has completed successfully and its findings — including zero findings — are confirmed visible in the Security tab.

---

**Note:** the codebase is small, so expect few findings. The value now is that the control grows with the code rather than being retrofitted onto a large codebase later.

## Comments

**2026-09-11 — workflow landed; awaiting a first run.**

`.github/workflows/codeql.yml`, job name `Analyze JavaScript/TypeScript`. Triggers on pull requests to `dev` and `main`, on push to those branches, and weekly on Monday 06:00 UTC.

`build-mode: none` is correct here. The `javascript-typescript` extractor reads source directly and does not need the TypeScript compiler to have run, so pointing CodeQL at a build would add several minutes for no additional coverage. The `security-and-quality` query suite is used rather than the default, which is a wider net; on a codebase this small the extra noise costs nothing and the habit is worth forming early.

Permissions are `contents: read` at the workflow level, widened to `security-events: write` on the analyze job alone, which is the minimum for uploading SARIF to code scanning.

Two criteria stay open until this runs on GitHub:

- *Results appear in the Security tab.* Cannot be confirmed from a local branch. Check Security → Code scanning after the first run.
- *A completed run with findings confirmed visible, including zero findings.* Same. Expect few or none on a walking skeleton; the value is that the control grows with the code rather than being retrofitted later.

Push triggers are included alongside pull requests so `dev` and `main` carry their own baseline, which is what lets code scanning distinguish a finding a pull request introduces from one it inherits.
