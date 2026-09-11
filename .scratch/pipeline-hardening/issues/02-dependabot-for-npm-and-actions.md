# 02: Dependabot for npm and actions

**What to build:** Dependabot raises pull requests that keep dependencies current, rather than only alerting that they are not. Two ecosystems: `npm` for application dependencies, and `github-actions` to keep the pinned SHAs from ticket 01 from decaying into permanently outdated actions.

Minor and patch updates are grouped into one pull request per ecosystem per week so that staying current does not mean a queue of trivial pull requests. Majors are raised individually, because those are the ones worth reading.

**Blocked by:** 01.

**Status:** in-progress

- [x] A `dependabot.yml` covers both the `npm` and `github-actions` ecosystems on a weekly schedule.
- [x] Minor and patch updates are grouped into a single pull request per ecosystem.
- [x] Major updates are raised as individual pull requests.
- [x] Dependabot pull request titles follow Conventional Commits, so they pass the linter from ticket 10.
- [ ] A Dependabot run has actually been triggered and observed producing the expected grouping, rather than assumed from config.
- [ ] An action update from Dependabot is confirmed to bump both the SHA and its version comment together.

## Comments

**2026-09-11 — config landed; the two observation criteria remain open.**

`.github/dependabot.yml` covers `npm` and `github-actions`, both weekly on Monday 06:00 Asia/Manila.

Grouping uses `applies-to: version-updates` with `update-types: [minor, patch]` and a `*` pattern, which is the construction that collects minor and patch into one pull request per ecosystem while leaving majors ungrouped. Majors then arrive individually and get read, which is the point. Security updates are deliberately left outside the group so a fix is never held behind an unrelated version bump.

Titles come from `commit-message.prefix`: `chore` for npm and `ci` for actions, with `include: scope`. Both are Conventional Commits subjects, so ticket 10's linter will pass them.

Two criteria cannot be ticked from a config file, and are not:

- *A Dependabot run producing the expected grouping.* Dependabot does not evaluate the config until it is on the default branch. Verify after this merges to `main`, either by waiting for Monday or by forcing a run from Insights → Dependency graph → Dependabot → Check for updates.
- *An action update bumping SHA and comment together.* Needs a real action release after this lands. The next `actions/checkout` patch is the natural first test.

---

**Migrated to GitHub issue #13** (https://github.com/aszeffs/SchoolGrid/issues/13). That issue is the source of truth; this file is kept as a record.
