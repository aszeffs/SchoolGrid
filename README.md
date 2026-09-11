# SchoolGrid

Unified digital infrastructure for school administration, course management, and student performance tracking.

Built as a practice ground for DevSecOps. The domain is deliberately security-heavy: every record belongs to exactly one School, access derives from scoped relationships rather than from credentials, and every refusal is designed to leak nothing about what exists. The security properties are in the domain, not bolted on afterwards.

## Status

Walking skeleton. The service boots, connects to Postgres and answers a health endpoint, and the test harness is in place. No domain behaviour yet.

## Running it

```bash
npm install       # runs only the install scripts allowlisted in package.json
npm test          # starts a real PostgreSQL; no Docker required
npm run typecheck
```

`npm test` needs no database of your own. The suite downloads and runs a genuine PostgreSQL binary, migrates a template database once, and hands every test its own copy of it. Tests are therefore isolated, and the guarantees under test are real database guarantees rather than a fake's approximation of them.

To run the service itself, copy `.env.example` to `.env`, point `DATABASE_URL` at a Postgres you control, then `npm run dev`. Migrations are applied on startup.

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
- **[ADR-0002](docs/adr/0002-uniform-safe-denial.md)** — every refusal returns an identical response. Absent, cross-School, and forbidden are indistinguishable to the caller by design; the real reason goes only to the audit trail.
- **[ADR-0003](docs/adr/0003-per-student-publication-semantics.md)** — publication is an irreversible per-Student fact reached through a per-offering act.

## Testing approach

There is exactly one seam: the HTTP request boundary. Every test issues a request through the client returned by the test harness and asserts on the response a caller would receive.

This is deliberate. ADR-0002 guarantees that two refusals are indistinguishable *to the caller*, and that is only assertable where a caller actually stands. A test below HTTP can confirm a denial happened; it cannot confirm that a cross-School denial and an absent-record denial look the same. Please do not add a second seam for convenience.

## Contributing

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). The allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore` and `ci`. A title reads `type(optional scope): subject`, with `!` before the colon for a breaking change. Keep subjects short and imperative.

Pull request titles follow the same convention and are checked by the commit lint workflow when a pull request is opened, edited or pushed to. The title is the target rather than the branch's own commits because merges are squash-only: the title becomes the commit subject on the trunk, and the branch's commits are discarded by the squash.

The check reports its verdict in the workflow job summary and never fails. It guards a convention rather than a property of the software, so it must not be the thing standing between a security fix and `main`. Fix the title and the next run agrees.

## Security controls

| Control | What it catches |
| --- | --- |
| Gitleaks, full history, on push and weekly | Credentials committed at any point, not just at the tip. |
| GitHub secret scanning with push protection | Blocks a credential at `git push`, before it reaches the remote. |
| Dependency review on pull requests | Vulnerable or copyleft-licensed dependencies entering through a PR. |
| `allowScripts` in `package.json` | Install-time code execution. Scripts run only for exact allowlisted versions, so a new one needs a visible change here. |
| Distroless runtime image, built on every pull request | A shell, a package manager, a dev dependency or a root user reaching the runtime image. The properties are asserted against the built artifact, not against the Dockerfile. |

Image scanning, publication and attestation arrive with the tickets that add them; the image itself is built and checked on every pull request but never pushed.
