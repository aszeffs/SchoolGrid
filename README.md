# SchoolGrid

Unified digital infrastructure for school administration, course management, and student performance tracking.

Built as a practice ground for DevSecOps. The domain is deliberately security-heavy: every record belongs to exactly one School, access derives from scoped relationships rather than from credentials, and every refusal is designed to leak nothing about what exists. The security properties are in the domain, not bolted on afterwards.

## Status

The service boots, connects to Postgres and answers a health endpoint, and the test harness is in place. User accounts can authenticate, carry a bearer session across requests, and end it (`POST`, `GET` and `DELETE /session`). No School-scoped behaviour yet.

## Running it

```bash
npm install       # runs only the install scripts allowlisted in package.json
npm test          # starts a real PostgreSQL; no Docker required
npm run typecheck
```

`npm test` needs no database of your own. The suite downloads and runs a genuine PostgreSQL binary, migrates a template database once, and hands every test its own copy of it. Tests are therefore isolated, and the guarantees under test are real database guarantees rather than a fake's approximation of them.

To run the service itself, copy `.env.example` to `.env`, create the application's database role as described in [docs/database-roles.md](docs/database-roles.md), point `MIGRATION_DATABASE_URL` at the schema owner and `DATABASE_URL` at that role, then `npm run dev`. Migrations are applied on startup, as the owner. The service refuses to start if `DATABASE_URL` could alter an Audit record.

## Branches

`main` is the trunk and the default branch. `dev` is the integration branch; feature branches merge into `dev`, which is promoted to `main` at release.

## Where things live

| Path | What it holds |
| --- | --- |
| `CONTEXT.md` | The domain glossary. The authority on vocabulary — use its terms, avoid the ones it lists under `_Avoid_`. |
| `docs/adr/` | Architecture decision records. Read the ones covering an area before changing it. |
| `docs/agents/` | Conventions for agents working in this repo. |
| `.scratch/<feature>/` | Specs and implementation tickets, one directory per feature. |
| `migrations/` | Plain SQL, applied in filename order. Never edit an applied migration; add a new one. |

## Decisions worth knowing before reading the code

Three choices are load-bearing and will look wrong without their context:

- **[ADR-0001](docs/adr/0001-school-scoped-person-identity.md)** — no domain object spans Schools. There is no shared identity, no district rollup, and a departing Student's records travel nowhere.
- **[ADR-0002](docs/adr/0002-uniform-safe-denial.md)** — every refusal returns an identical response. Absent, cross-School, and forbidden are indistinguishable to the caller by design; the real reason goes only to the audit trail. Its addendum scopes this: a response may vary with the caller's own request but never with what exists, so throttling keeps its own `429`.
- **[ADR-0003](docs/adr/0003-per-student-publication-semantics.md)** — publication is an irreversible per-Student fact reached through a per-offering act.

## Testing approach

Behaviour a caller can observe has exactly one seam: the HTTP request boundary. Every such test issues a request through the client returned by the test harness and asserts on the response a caller would receive.

This is deliberate. ADR-0002 guarantees that two refusals are indistinguishable *to the caller*, and that is only assertable where a caller actually stands. A test below HTTP can confirm a denial happened; it cannot confirm that a cross-School denial and an absent-record denial look the same. Please do not add a second seam for convenience.

The rule governs what a caller can observe, so three kinds of test sit outside it, and nothing else should:

- **Startup configuration.** `loadConfig` runs before any caller exists, and a bad value must stop the process rather than surface in a response (`tests/config.test.ts`).
- **Database guarantees no caller can see.** Migration integrity, schema shape, and what is stored in place of a credential are asserted against the database directly (`tests/migrations.test.ts`, parts of `tests/authentication.test.ts`).
- **Repository tooling.** Scripts under `scripts/` are not the service and are tested as the programs they are.

## Contributing

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). The allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore` and `ci`. A title reads `type(optional scope): subject`, with `!` before the colon for a breaking change. Keep subjects short and imperative.

Pull request titles follow the same convention and are checked by the commit lint workflow when a pull request is opened, edited or pushed to. The title is the target rather than the branch's own commits because merges are squash-only: the title becomes the commit subject on the trunk, and the branch's commits are discarded by the squash.

The check reports its verdict in the workflow job summary and never fails. It guards a convention rather than a property of the software, so it must not be the thing standing between a security fix and `main`. Fix the title and the next run agrees.

## Security controls

| Control | What it catches |
| --- | --- |
| In-process rate limit on every route, per client address | A flood of requests turning into database round trips and exhausting the connection pool. Unknown routes count too, so probing for paths is not free. Over the limit a client gets `429 {"status":"rate_limited"}` with `Retry-After`. Set with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` (default 100 per minute). Counts are held per instance, and behind a reverse proxy every client shares the proxy's address, so a deployment should limit at the proxy as well. |
| Gitleaks, full history, on push and weekly | Credentials committed at any point, not just at the tip. |
| GitHub secret scanning with push protection | Blocks a credential at `git push`, before it reaches the remote. |
| Dependency review on pull requests | Vulnerable or copyleft-licensed dependencies entering through a PR. |
| `allowScripts` in `package.json` | Install-time code execution. Scripts run only for exact allowlisted versions, so a new one needs a visible change here. |
| Distroless runtime image, built on every pull request | A shell, a package manager, a dev dependency or a root user reaching the runtime image. The properties are asserted against the built artifact, not against the Dockerfile. |
| Publication to GHCR from `main` only, after the scan and smoke test | An unreviewed, vulnerable or unstartable image reaching the registry. Pull requests build and check the image but never push it, and only the publishing job holds a token that can. |
| Images tagged by full commit SHA | A running image that cannot be traced back to its source. `latest` moves only to the current head of `main`, never backwards to an older merge. |
| Anonymous pull and boot after every publish | A package that is private, or a push that did not produce a runnable image. The check runs on a fresh runner with no registry credentials. |
| Keyless SLSA build provenance and SBOM attestations on every published image | An image pushed to the registry by anything other than this repository's container workflow building a commit on `main`. Signed with the workflow's OIDC identity, so there is no signing key to leak; only the attesting job can request that identity. Verified after every publish with the same command a consumer runs. |

## Published images

Every merge to `main` publishes `ghcr.io/aszeffs/schoolgrid`, tagged with the full commit SHA and `latest`. The package is public and needs no login:

```bash
docker pull ghcr.io/aszeffs/schoolgrid:<full-commit-sha>
```

Prefer the commit tag. `latest` tells you what is newest, not what you are running.

The package is public so that anyone, not only the maintainer, can verify where an image came from. Nothing sets that by hand: the image carries an `org.opencontainers.image.source` label pointing at this repository and is pushed with the workflow's own token, so GHCR links the package to the repository and gives it the repository's public visibility. A package can still be made private from its settings, independently of the repository, and the anonymous pull job after every publish is what would catch that.

### Verifying an image

Every published image carries two signed attestations, stored both with GitHub and beside the image in the registry: SLSA build provenance, recording the workflow, commit and ref that built it, and an SPDX SBOM listing what is inside. They are signed through Sigstore with the build workflow's own identity, so there is no public key to fetch; the identity is what you check.

You need the [GitHub CLI](https://cli.github.com/) logged in to any GitHub account. You do not need access to anything beyond this public repository. Name the image by digest, so the check covers the bytes you will run rather than whatever a tag points at by then:

```bash
IMAGE=ghcr.io/aszeffs/schoolgrid
DIGEST="$(docker buildx imagetools inspect "$IMAGE:<full-commit-sha>" --format '{{.Manifest.Digest}}')"

gh attestation verify "oci://$IMAGE@$DIGEST" \
  --repo aszeffs/SchoolGrid \
  --signer-workflow aszeffs/SchoolGrid/.github/workflows/container.yml \
  --source-ref refs/heads/main \
  --source-digest <full-commit-sha> \
  --deny-self-hosted-runners
```

A pass means this repository's container workflow, running on a GitHub-hosted runner, built that exact digest from that commit on `main`. Drop `--source-digest` to accept any commit from `main`. `--repo` alone is weaker than it looks: it accepts a statement signed by *any* workflow in the repository, which is why `--signer-workflow` is there. Add `--bundle-from-oci` to read the attestations from the registry instead of from GitHub. Then pull by that digest, `docker pull "$IMAGE@$DIGEST"`, rather than by the tag, which may have moved since you checked.

To check the SBOM, and read it without pulling the image:

```bash
gh attestation verify "oci://$IMAGE@$DIGEST" \
  --repo aszeffs/SchoolGrid \
  --signer-workflow aszeffs/SchoolGrid/.github/workflows/container.yml \
  --source-ref refs/heads/main \
  --source-digest <full-commit-sha> \
  --deny-self-hosted-runners \
  --predicate-type https://spdx.dev/Document/v2.3 \
  --format json --jq '.[0].verificationResult.statement.predicate' > sbom.spdx.json
```

The SBOM is generated by Trivy from the exact image the scan passed, before it is pushed.
