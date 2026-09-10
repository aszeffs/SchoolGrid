# 02: Dependabot for npm and actions

**What to build:** Dependabot raises pull requests that keep dependencies current, rather than only alerting that they are not. Two ecosystems: `npm` for application dependencies, and `github-actions` to keep the pinned SHAs from ticket 01 from decaying into permanently outdated actions.

Minor and patch updates are grouped into one pull request per ecosystem per week so that staying current does not mean a queue of trivial pull requests. Majors are raised individually, because those are the ones worth reading.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] A `dependabot.yml` covers both the `npm` and `github-actions` ecosystems on a weekly schedule.
- [ ] Minor and patch updates are grouped into a single pull request per ecosystem.
- [ ] Major updates are raised as individual pull requests.
- [ ] Dependabot pull request titles follow Conventional Commits, so they pass the linter from ticket 10.
- [ ] A Dependabot run has actually been triggered and observed producing the expected grouping, rather than assumed from config.
- [ ] An action update from Dependabot is confirmed to bump both the SHA and its version comment together.
