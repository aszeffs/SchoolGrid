# 10: Conventional commit linting

**What to build:** Pull request titles are checked against Conventional Commits, and the check reports without blocking.

The title is the right target because merges are squash-only: the pull request title becomes the commit subject on the trunk. Linting individual branch commits would police messages that squashing discards.

The check is deliberately advisory. A naming quibble should never be the thing standing between a security fix and `main`, and this is the one check in the effort that guards a convention rather than a property of the software.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Pull request titles are validated against Conventional Commits on open, edit, and synchronise.
- [ ] The allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, and `ci`.
- [ ] A failing title reports clearly but does not block the merge.
- [ ] Dependabot's own pull request titles pass the check.
- [ ] The convention and its allowed types are documented in the README.

---

**Migrated to GitHub issue #20** (https://github.com/aszeffs/SchoolGrid/issues/20). That issue is the source of truth; this file is kept as a record.
