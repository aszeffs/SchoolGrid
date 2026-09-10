# 03: Audit gate and coverage reporting

**What to build:** Two additions to CI that cover gaps in what already runs.

First, `npm audit` gating on high severity. Dependency review only inspects what a pull request *adds*, so a CVE disclosed tomorrow against a package installed today currently fails no build. The audit covers the whole installed tree, and a weekly schedule is what catches an advisory against code nobody is touching.

Second, coverage reporting — measured and visible, with no threshold yet. A percentage on a walking skeleton tells you nothing useful, and a threshold set too early just teaches you to game it. This ticket makes the number visible so a floor can be set later against real code.

Coverage goes to the workflow summary and a run artifact. No third-party service: adding an integration with repository access to measure code quality would widen the supply-chain surface this whole effort exists to narrow.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `npm audit --audit-level=high` runs as its own job on pull requests and on a weekly schedule.
- [ ] The job fails the build on a high or critical advisory anywhere in the installed tree.
- [ ] The gate is demonstrated failing by temporarily installing a package with a known high-severity advisory; evidence recorded here and the change reverted.
- [ ] Vitest produces a coverage report on each CI run.
- [ ] Coverage is written to the workflow job summary and uploaded as a run artifact.
- [ ] No coverage threshold is enforced, and no third-party coverage service is added.
