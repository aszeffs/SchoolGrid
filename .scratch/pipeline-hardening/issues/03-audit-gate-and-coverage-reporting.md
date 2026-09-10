# 03: Audit gate and coverage reporting

**What to build:** Two additions to CI that cover gaps in what already runs.

First, `npm audit` gating on high severity. Dependency review only inspects what a pull request *adds*, so a CVE disclosed tomorrow against a package installed today currently fails no build. The audit covers the whole installed tree, and a weekly schedule is what catches an advisory against code nobody is touching.

Second, coverage reporting — measured and visible, with no threshold yet. A percentage on a walking skeleton tells you nothing useful, and a threshold set too early just teaches you to game it. This ticket makes the number visible so a floor can be set later against real code.

Coverage goes to the workflow summary and a run artifact. No third-party service: adding an integration with repository access to measure code quality would widen the supply-chain surface this whole effort exists to narrow.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `npm audit --audit-level=high` runs as its own job on pull requests and on a weekly schedule.
- [x] The job fails the build on a high or critical advisory anywhere in the installed tree.
- [x] The gate is demonstrated failing by temporarily installing a package with a known high-severity advisory; evidence recorded here and the change reverted.
- [x] Vitest produces a coverage report on each CI run.
- [x] Coverage is written to the workflow job summary and uploaded as a run artifact.
- [x] No coverage threshold is enforced, and no third-party coverage service is added.

## Comments

**2026-09-11 — both halves landed; gate demonstrated failing.**

*Audit.* `.github/workflows/audit.yml`, job name `npm audit`, on pull requests to `dev` and `main` and weekly on Monday 06:00 UTC. It is a separate workflow rather than a job inside CI because CI has no schedule trigger, and adding one there would run the whole typecheck-build-test cycle weekly to get one audit.

The gate was demonstrated failing rather than assumed. Baseline `npm audit --audit-level=high` on the clean tree reports zero vulnerabilities and exits 0. With `lodash@4.17.11` installed as a dev dependency it reports one critical severity vulnerability across seven advisories and exits 1, which is what fails the step:

```
lodash  <=4.17.23
Severity: critical
Command Injection in lodash - https://github.com/advisories/GHSA-35jh-r3h4-6jhm
Prototype Pollution in lodash - https://github.com/advisories/GHSA-jf85-cpcp-j695
...
1 critical severity vulnerability
GATE EXIT: 1
```

`package.json` and `package-lock.json` were restored and `npm ci` re-run; the tree is back to zero vulnerabilities and no lodash entry remains in the lockfile. The demonstration is recorded here and not in the repository, as the spec requires.

Worth noting what this covers that dependency review does not. Lodash was a *dev* dependency and the advisory was pre-existing rather than introduced by a diff — precisely the two blind spots the audit exists to fill.

*Coverage.* Vitest v8 provider, `include: src/**/*.ts`, reporters `text`, `text-summary`, `html` and `json-summary`, output to `coverage/` which is already gitignored. `npm run test:coverage` is the script; CI runs it in place of `npm test`.

`scripts/coverage-summary.mjs` reads `coverage-summary.json` and renders a Markdown table appended to `$GITHUB_STEP_SUMMARY`, and the whole `coverage/` directory uploads as a run artifact with 14-day retention. Both steps are `if: always()`, so a failing test run still reports the coverage it managed to collect. The script returns a "No coverage report was produced" line rather than throwing when the report is absent, which is what keeps a failed test run from being masked by a second, confusing failure in the summary step.

No threshold is configured and no third-party service was added. Current numbers on the walking skeleton, for a later floor to be set against:

| Statements | Branches | Functions | Lines |
| ---: | ---: | ---: | ---: |
| 37.5% (36/96) | 15.62% (5/32) | 58.82% (10/17) | 37.36% (34/91) |

The formatter has unit tests in `tests/coverage-summary.test.ts` covering the rendered table and the missing-report path.
