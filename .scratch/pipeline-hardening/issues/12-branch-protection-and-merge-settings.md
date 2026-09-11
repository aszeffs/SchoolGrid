# 12: Branch protection and merge settings

**What to build:** The rules that turn every control in this effort from advisory into enforced. Until this lands, each workflow can be bypassed by pushing directly to the branch.

`main` and `dev` both require a pull request and passing checks, refuse force pushes and deletion, require signed commits, and apply to administrators. Required approving reviews are set to **zero** — GitHub does not allow approving your own pull request, so any other value makes the repository unmergeable by its only maintainer. The gate that matters here is "nothing merges red", and that works fine without a second human.

Merges are squash-only, so each pull request becomes one commit and trunk history stays linear.

This ticket lands last because it must reference status checks that already exist.

**Blocked by:** 04, 06, 07, 11.

**Status:** ready-for-agent

## 12a — Enforcement over the checks that exist

Landable as soon as 04 and 11 are done. Every box below can be ticked without the container pipeline existing.

- [x] PR #1 (the walking skeleton) is merged **before** signed commits are required — its commits are unsigned, and squash-merging does not help because GitHub still evaluates the branch's own commits.
- [ ] Ticket 11 is confirmed complete and signing verified working.
- [ ] `main` and `dev` both require a pull request, with required approving reviews set to zero.
- [ ] Required status checks, by their **job name** as reported to the checks API: `Typecheck, build and test`, `Gitleaks`, `Review dependency changes`, `npm audit`, `Analyze JavaScript/TypeScript`.
- [ ] Commit lint and coverage are explicitly **not** required.
- [ ] Branches must be up to date before merging.
- [ ] Force pushes and branch deletion are blocked on both branches.
- [ ] Signed commits are required.
- [ ] Rules apply to administrators, including the repository owner.
- [ ] Squash merge is the only enabled merge strategy; merge commits and rebase merging are disabled.
- [ ] A direct push to `main` is attempted and confirmed refused; evidence recorded here.
- [ ] A pull request with a failing check is confirmed unmergeable.

## 12b — Adding the container checks

Blocked by 06 and 07. Do not add these names until the workflows exist and have reported at least once on a pull request.

- [ ] Container build added to required status checks.
- [ ] Container smoke test added to required status checks.
- [ ] Trivy image scan added to required status checks.

---

**Note for the implementer:** an admin bypass you use on every merge is not a control. If a rule proves genuinely unworkable, change the rule deliberately and record why — do not route around it.

## Comments

**2026-09-11 — split into 12a and 12b, and status checks named exactly.**

Three corrections, all found while implementing 01, 02, 03, 04 and 11.

*PR #1 is already merged.* It went in as a merge commit on `dev` before signing was set up, so the ordering hazard this ticket warns about has already been cleared rather than still being pending. Ticked.

*A required check that never reports blocks merging forever.* The original acceptance list named seven required checks, three of which — Trivy image scan, container build, container smoke test — belong to tickets 05 through 09 and do not exist. GitHub does not skip a required check that no workflow produces; it holds the pull request in "Expected — waiting for status to be reported" indefinitely, and admin enforcement means the owner cannot override it either. That is the lockout this effort's sequencing notes exist to avoid, arriving from a different direction. Hence the split: 12a enforces what exists and unblocks on 04 and 11 alone, 12b adds the container checks once 06 and 07 have reported on a real pull request.

*Required checks are matched by job name, not workflow name.* GitHub's required-status-check list matches the `name:` of the job as it appears in the checks API, which for these workflows is the job's `name:` field and not the workflow's. Naming them wrongly produces the same silent never-reports failure. The exact strings are now in the ticket. If a job is renamed later, the protection rule must be updated in the same change or trunk becomes unmergeable.

One thing deliberately not changed: required approving reviews stay at zero, and the reasoning in the body still holds.

**2026-09-11 — `npm audit` added to the required list, deliberately.**

The spec enumerates seven required status checks and `npm audit` is not among them, because ticket 03's audit gate did not exist when the spec was written. It is now a job that runs on every pull request and fails on a high or critical advisory, which is exactly the shape of the other required checks. Requiring it is a deliberate addendum to the spec's list rather than an oversight. The alternative — a gate that runs, goes red, and merges anyway — is the advisory-control problem this whole effort exists to fix.

---

**Migrated to GitHub issue #22** (https://github.com/aszeffs/SchoolGrid/issues/22). That issue is the source of truth; this file is kept as a record.
