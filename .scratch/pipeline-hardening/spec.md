# Pipeline Hardening

Status: ready-for-agent

## Problem Statement

SchoolGrid has continuous integration and three security controls, and none of it is enforced. `main` and `dev` are unprotected, so every workflow in the repository is advisory: a push straight to trunk bypasses the typecheck, the tests, the secret scan and the dependency review simultaneously. A control that can be skipped by doing nothing is not a control.

Underneath that sit three narrower gaps. Every action reference is a mutable tag — `actions/checkout@v4`, `gitleaks-action@v2` — and a tag can be repointed at new code by whoever controls that action's repository, which is exactly how the `tj-actions/changed-files` compromise executed attacker code inside thousands of pipelines with their tokens. There is no static analysis of the application code at all. And dependency review only inspects what a pull request *adds*, so a CVE disclosed tomorrow against a package installed today fails no build and blocks no merge.

The larger absence is the CD half. Nothing produces a deployable artifact. That means there is no image to scan, no SBOM describing what ships, and no provenance proving which commit and which workflow produced a given artifact. It also means one class of defect is currently untestable: the test suite drives the application through Fastify's `inject`, which never starts the real process, so a broken entrypoint, a production dependency missing from the runtime image, or a migration that fails on boot would all pass CI and only surface on a real deployment.

## Solution

Turn the existing advisory controls into gates, close the supply-chain gaps on the way in, and build a verifiable artifact on the way out.

**On the way in.** Every action pins to a full commit SHA, so a moved tag cannot change what executes in the pipeline. Dependabot keeps both npm packages and those action SHAs current through grouped weekly pull requests. `npm audit` gates on high severity across the whole installed tree, covering what dependency review structurally cannot. CodeQL analyses the application code on pull requests and weekly, because new rules find old bugs.

**On the way out.** A multi-stage build produces a distroless runtime image — no shell, no package manager, non-root by default — which is built and scanned on every pull request but pushed to GHCR only from `main`, tagged by commit SHA. Trivy fails the build on high and critical findings. Each published image carries a signed SLSA build provenance statement and an SBOM attestation, both public, so anyone can verify which commit and workflow produced the image and what is inside it.

**Runtime.** The built image runs against a real Postgres and must answer `/health`. This is the only check in the pipeline that starts the actual process, so it is the only one that can catch a broken entrypoint or a migration that fails on boot.

**Enforcement.** `main` and `dev` require a pull request and passing checks, allow no force pushes, and demand signed commits. Approvals are set to zero, because GitHub does not permit approving your own pull request and any other setting makes the repository unmergeable by its only maintainer. Merges are squash-only, so each pull request becomes one commit and the pull request title is what a commit-message linter needs to check.

## User Stories

### Enforcement

1. As the maintainer, I want `main` and `dev` to reject direct pushes, so that no change reaches trunk without passing the checks.
2. As the maintainer, I want merges blocked while any required check is failing, so that trunk is never knowingly broken.
3. As the maintainer, I want to merge my own pull requests without an approving review, so that being the only maintainer does not make the repository unmergeable.
4. As the maintainer, I want force pushes to protected branches refused, so that published history cannot be rewritten.
5. As the maintainer, I want branch deletion of `main` and `dev` blocked, so that the trunk cannot be removed by accident.
6. As the maintainer, I want the protection rules to apply to me as well, so that the rule is a control rather than a suggestion.
7. As the maintainer, I want squash-merge to be the only available merge strategy, so that trunk history stays linear and each pull request is one commit.
8. As a reader of the history, I want every commit signed and verified, so that authorship cannot be spoofed by setting a name and email in git config.
9. As the maintainer, I want signing working locally before it is required remotely, so that enabling the rule does not lock me out of my own repository.

### Supply chain, inbound

10. As the maintainer, I want every action pinned to a full commit SHA, so that a moved tag cannot change what runs in my pipeline.
11. As a reader of a workflow file, I want each pinned SHA annotated with its human-readable version, so that the file stays legible.
12. As the maintainer, I want Dependabot to raise pull requests for npm dependencies, so that fixes arrive as changes I can merge rather than alerts I have to act on.
13. As the maintainer, I want Dependabot to keep action SHAs current, so that pinning does not decay into running permanently outdated actions.
14. As the maintainer, I want minor and patch updates grouped into one pull request, so that keeping current does not mean a queue of trivial pull requests.
15. As the maintainer, I want a build to fail on a high-severity advisory anywhere in the installed dependency tree, so that a CVE in an unchanged package is caught rather than merely reported.
16. As the maintainer, I want the audit to run on a schedule as well as on pull requests, so that a CVE disclosed against code nobody is touching still surfaces.
17. As the maintainer, I want static analysis of the application code on every pull request, so that injection and data-handling flaws are caught before merge.
18. As the maintainer, I want static analysis findings in the repository's Security tab, so that all findings live in one place.

### Artifact and supply chain, outbound

19. As the maintainer, I want a container image built from the repository, so that there is a deployable artifact to secure.
20. As the maintainer, I want the runtime image to contain no shell and no package manager, so that an attacker achieving code execution finds no tooling to work with.
21. As the maintainer, I want the runtime image to run as a non-root user, so that a container escape starts from the weakest possible position.
22. As the maintainer, I want build tooling and dev dependencies excluded from the runtime image, so that the shipped attack surface is only what the application needs.
23. As the maintainer, I want the image built and scanned on pull requests without being published, so that a vulnerable image is caught before it exists in the registry.
24. As the maintainer, I want images published only from `main`, so that nothing unreviewed reaches the registry.
25. As the maintainer, I want each image tagged with the commit SHA that produced it, so that a running image can be traced back to source.
26. As the maintainer, I want the build to fail on high and critical image vulnerabilities, so that known-vulnerable images are never published.
27. As the maintainer, I want image scan results in the Security tab alongside static analysis findings, so that there is one place to look.
28. As a consumer of the image, I want signed build provenance, so that I can verify which workflow and which commit produced it.
29. As a consumer of the image, I want an SBOM attestation, so that I can determine what is inside without pulling and unpacking it.
30. As a consumer of the image, I want the package public, so that the provenance chain is verifiable by someone who is not the maintainer.
31. As the maintainer, I want provenance generated without managing signing keys, so that there is no private key to leak or rotate.

### Runtime verification

32. As the maintainer, I want the built image started in the pipeline, so that something proves the artifact actually runs.
33. As the maintainer, I want the running container checked against a real Postgres, so that a migration failing on boot is caught.
34. As the maintainer, I want the smoke test to fail if `/health` does not report the database reachable, so that a broken entrypoint or missing production dependency cannot merge.
35. As the maintainer, I want the smoke test to run before publication, so that an image that cannot start is never pushed.

### Convention and visibility

36. As the maintainer, I want pull request titles checked against Conventional Commits, so that the convention survives a busy day.
37. As the maintainer, I want the commit-message check to be advisory rather than blocking, so that a naming quibble cannot block a security fix.
38. As the maintainer, I want test coverage reported on each run, so that I can see whether tests are keeping up with the code.
39. As the maintainer, I want coverage visible without granting a third-party service access to the repository, so that measuring quality does not widen the supply-chain surface.

## Implementation Decisions

**Branch protection.** `main` and `dev` both protected. Require a pull request; required approving reviews set to **zero**; require branches be up to date before merging; block force pushes and deletions; require signed commits; apply rules to administrators. Required status checks: CI, secret scan, dependency review, CodeQL, Trivy image scan, container build, and container smoke test. Commit lint and coverage report but do not block.

**Merge strategy.** Squash merge only; merge commits and rebase merging disabled in repository settings. The pull request title becomes the trunk commit subject, which is why the commit linter targets the title.

**Signing.** SSH signing rather than GPG — reuse an existing SSH key, set `gpg.format=ssh`, `user.signingkey`, and `commit.gpgsign=true`, and register the key on the account with signing scope. No keyring, no expiry, no subkeys. Must be verified working before protection requires it.

**Action pinning.** Every `uses:` references a 40-character commit SHA with a trailing comment naming the version, for example `uses: actions/checkout@<sha> # v4.2.2`. Dependabot's `github-actions` ecosystem updates the SHAs and the comments together.

**Dependabot.** Two ecosystems, `npm` and `github-actions`, weekly. Minor and patch updates grouped into a single pull request per ecosystem; majors raised individually so they get read.

**Audit gate.** `npm audit --audit-level=high` as its own job, on pull requests and on a weekly schedule. High rather than moderate keeps it actionable; the schedule is what catches newly disclosed CVEs in code nobody has touched.

**CodeQL.** GitHub's own action, JavaScript/TypeScript, on pull requests and weekly, uploading SARIF to code scanning.

**Container.** Multi-stage: build on a full Node image, produce a runtime stage on distroless Node. Only production dependencies and compiled output are copied forward. No shell, no package manager, non-root by default. The image runs the compiled entrypoint, which applies migrations on start.

**Registry and tagging.** GHCR, package visibility public. Tags: the commit SHA always, and `latest` on `main`. Pull requests build the image but never push.

**Attestation.** `actions/attest-build-provenance` and `actions/attest-sbom`, keyless via the workflow's OIDC identity. Requires `id-token: write` and `attestations: write`, granted per job rather than at workflow level. Verifiable with `gh attestation verify`.

**Smoke test.** A job that starts a Postgres service container, runs the built image against it, polls `/health` until it returns 200 with the database reachable, and fails on timeout. It runs after the build and gates publication.

**Coverage.** Vitest coverage written to the workflow job summary and uploaded as a run artifact. No third-party integration and no token.

**Workflow permissions.** Every workflow declares least-privilege `permissions` at the top and widens only the specific job that needs more. No workflow gets blanket write access.

## Testing Decisions

The pipeline is largely self-verifying: a workflow either passes or it does not, on real infrastructure. What matters is that each control is proven to *fail* when it should, not merely observed passing on a clean tree. A control that has only ever been seen green is untested.

Each ticket that adds a gate must demonstrate the gate firing, then revert the demonstration. Concretely: the audit gate is shown failing against a deliberately vulnerable package; Trivy is shown failing against a base image with a known high-severity CVE; the smoke test is shown failing against an image with a deliberately broken entrypoint; branch protection is shown refusing a direct push to `main`. Evidence goes in the ticket, not into the repository.

Where a check is expensive to prove negative — CodeQL, provenance attestation — verify the positive path end to end instead: for provenance, actually run `gh attestation verify` against a published image and confirm it reports the expected workflow and commit.

Prior art: `.github/workflows/ci.yml`, `secret-scan.yml` and `dependency-review.yml` establish the existing conventions — top-level least-privilege `permissions`, explicit branch filters on `dev` and `main`, and comments explaining *why* a step exists rather than what it does. Follow them.

## Out of Scope

Deployment to a running environment. This effort stops at a published, scanned, attested image; nothing is deployed anywhere, so there is no hosting, no environment configuration, and no runtime secrets management.

Consequently also out of scope: DAST and ZAP scanning, which need a deployed target and would find almost nothing against a lone health endpoint; infrastructure-as-code scanning, since there is no infrastructure; runtime security monitoring; and any secrets manager.

Also excluded: container signing with self-managed keys, since keyless attestation covers the need without key management; Codecov or any third-party coverage service; license compliance beyond the existing copyleft deny-list; penetration testing; and release automation such as changelog generation or semantic versioning, which becomes worth doing once there are releases to describe.

## Further Notes

**Sequencing is load-bearing and can lock you out.** Two orderings must hold. Signing must be set up and verified locally *before* protection requires it, or the next push is rejected with no remedy but disabling the rule. And PR #1 must be merged *before* signed commits are required, because its three commits are unsigned and squash-merging does not help — GitHub signs the squash commit but still evaluates the branch's own commits.

**This graph is genuinely parallel**, unlike the identity-and-access chain where each ticket blocked the next. Six tickets have no blockers at all, and the container work forms its own chain. Branch protection lands last because it must reference status checks that already exist.

**Expect Trivy to block you on something unfixable.** A high-severity CVE in a base image with no patched version available is normal. Working out how to record an exception, with a justification and an expiry, rather than lowering the threshold or disabling the gate, is one of the more useful things this effort will teach.
