# 12: Branch protection and merge settings

**What to build:** The rules that turn every control in this effort from advisory into enforced. Until this lands, each workflow can be bypassed by pushing directly to the branch.

`main` and `dev` both require a pull request and passing checks, refuse force pushes and deletion, require signed commits, and apply to administrators. Required approving reviews are set to **zero** — GitHub does not allow approving your own pull request, so any other value makes the repository unmergeable by its only maintainer. The gate that matters here is "nothing merges red", and that works fine without a second human.

Merges are squash-only, so each pull request becomes one commit and trunk history stays linear.

This ticket lands last because it must reference status checks that already exist.

**Blocked by:** 04, 06, 07, 11.

**Status:** ready-for-agent

- [ ] PR #1 (the walking skeleton) is merged **before** signed commits are required — its commits are unsigned, and squash-merging does not help because GitHub still evaluates the branch's own commits.
- [ ] Ticket 11 is confirmed complete and signing verified working.
- [ ] `main` and `dev` both require a pull request, with required approving reviews set to zero.
- [ ] Required status checks: CI, secret scan, dependency review, CodeQL, Trivy image scan, container build, container smoke test.
- [ ] Commit lint and coverage are explicitly **not** required.
- [ ] Branches must be up to date before merging.
- [ ] Force pushes and branch deletion are blocked on both branches.
- [ ] Signed commits are required.
- [ ] Rules apply to administrators, including the repository owner.
- [ ] Squash merge is the only enabled merge strategy; merge commits and rebase merging are disabled.
- [ ] A direct push to `main` is attempted and confirmed refused; evidence recorded here.
- [ ] A pull request with a failing check is confirmed unmergeable.

---

**Note for the implementer:** an admin bypass you use on every merge is not a control. If a rule proves genuinely unworkable, change the rule deliberately and record why — do not route around it.
