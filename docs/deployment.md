# Deployment

The public site runs on Vercel's Hobby plan against a Neon Postgres database. Production runs the exact image `main` published, verified and deployed by digest from CI alone ([ADR-0005](adr/0005-production-runs-the-verified-image.md)). This page is the one-time setup: follow it top to bottom to rebuild the deployment from nothing.

It holds Trial Schools only, of invented data, each deleted two hours after a visitor starts it ([ADR-0012](adr/0012-trial-schools-replace-the-shared-demo.md)). Hobby is for non-commercial, personal use. No sign-in is published: a trial's accounts have no password.

## What you need

- Accounts: Neon (free plan), Vercel (Hobby), and admin on this repository.
- Tools: `psql` 18, Docker, the GitHub CLI logged in, and Node for `npx vercel`.
- The digest of the image to run, verified as the README's [Verifying an image](../README.md#verifying-an-image) shows. Everything below that runs the image names it by that digest.

```bash
IMAGE=ghcr.io/aszeffs/schoolgrid
SHA="$(git rev-parse origin/main)"
DIGEST="$(docker buildx imagetools inspect "$IMAGE:$SHA" --format '{{.Manifest.Digest}}')"
```

## 1. The Neon project

Create it directly on Neon, never through Vercel's Marketplace: the Marketplace integration hands Vercel the owner's connection string, and Vercel must only ever hold the runtime role.

In the Neon console, **New project**: name `schoolgrid`, Postgres **18**, AWS **US East (N. Virginia) / us-east-1**, the region nearest Vercel's `iad1`. Then **Connect**, turn **Connection pooling off**, and copy the connection string. That is the schema owner on the direct endpoint:

```bash
OWNER_URL='postgresql://neondb_owner:<password>@ep-<name>.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
```

It goes to the GitHub `production` environment (step 5) and nowhere else.

## 2. The roles

As in [docs/database-roles.md](database-roles.md#setting-up-a-database). Neon's owner can create roles in SQL:

```bash
RUNTIME_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"
psql "$OWNER_URL" -X -v ON_ERROR_STOP=1 -v pw="$RUNTIME_PASSWORD" <<'SQL'
CREATE ROLE schoolgrid_app NOLOGIN;
CREATE ROLE schoolgrid_runtime LOGIN PASSWORD :'pw' IN ROLE schoolgrid_app;
SQL
```

The service connects through Neon's pooled endpoint: the same host with `-pooler` after its first label.

```bash
DATABASE_URL="postgresql://schoolgrid_runtime:$RUNTIME_PASSWORD@ep-<name>-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
psql "$DATABASE_URL" -XtAc 'SELECT current_user'   # schoolgrid_runtime
```

## 3. The first migrate

Migrate with the verified image, as the owner, exactly as the deploy job will:

```bash
MIGRATION_DATABASE_URL="$OWNER_URL" docker run --rm -e MIGRATION_DATABASE_URL \
  "$IMAGE@$DIGEST" dist/db/migrate-cli.js
```

Nothing is seeded. Each Trial School is built by the service when a visitor starts it, in one transaction and through the same domain operations the app uses, around the visitor's own today: a Person in each School role, invented Students and Guardians, and an Academic Year of Terms, Courses and Class Offerings. No Platform Administrator is needed; one is made by hand, as the owner, only if ever wanted ([docs/database-roles.md](database-roles.md#making-a-platform-administrator)).

## 4. The Vercel project

Create it from the CLI, in an empty directory, so no Git repository is ever connected:

```bash
npx vercel login
npx vercel project add schoolgrid
npx vercel link --yes --project schoolgrid
```

`.vercel/project.json` now holds the `orgId` and `projectId` step 5 needs. The production domain is under **Settings → Domains** (a `*.vercel.app` name).

Production environment variables, one `vercel env add <NAME> production` each:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The runtime role on the pooled endpoint, from step 2. Never the owner. |
| `PUBLIC_ORIGIN` | `https://` and the production domain, no trailing slash. |
| `PORT` | `3000`. Vercel's default is 80; the image listens on 3000. |
| `CLIENT_ADDRESS_HEADER` | `x-vercel-forwarded-for`. Inside the function every request comes from `127.0.0.1`, so without it every visitor shares one rate-limit count. Vercel overwrites the header, so a caller cannot choose their own. |
| `TRIALS_ENABLED` | `true`. Lets any visitor start a Trial School (ADR-0012). Off unless set. |
| `TRIAL_LIVE_CAP` | Optional; `30` unless set. The most Trial Schools live at once, the hard bound on what trials may hold in the free database tier. |
| `TRIAL_PER_IP_HOUR` | Optional; `2` unless set. The most trials one client address may start an hour, counted per instance. |
| `LOG_LEVEL` | `info` |

A project set up before Trial Schools still holds `DEMO_MODE`, which nothing reads any more: remove it with `vercel env rm DEMO_MODE production`.

`MIGRATION_DATABASE_URL` is deliberately absent: the service verifies the database is migrated and refuses to start if not. `IMAGE_DIGEST` is not set here; the deploy supplies it per deployment with `--env`.

In the project's **Settings**:

- **Functions → Function Region:** Washington, D.C. (`iad1`).
- **Git:** no repository connected. Connecting one would let Vercel build from source, which is what ADR-0005 rules out.
- **Deployment Protection → Vercel Authentication:** on, **Standard Protection**, so every URL but the production domain needs a Vercel sign-in.

The Container Images beta permission Vercel's docs mention is not shown anywhere in a Hobby account's settings. The function runs without it being visible.

## 5. The GitHub `production` environment

Only this environment holds the Vercel credentials and the owner's connection string, and only `main` can deploy to it:

```bash
REPO=aszeffs/SchoolGrid
echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
  | gh api -X PUT "repos/$REPO/environments/production" --input -
gh api -X POST "repos/$REPO/environments/production/deployment-branch-policies" -f name=main -f type=branch
```

Create a Vercel token at **Account Settings → Tokens**, scoped to the Hobby account, and note its expiry: the deploy fails once it lapses. Then, with each value on stdin so none lands in shell history:

| Secret | Value |
| --- | --- |
| `VERCEL_TOKEN` | The token. |
| `VERCEL_ORG_ID` | `orgId` from `.vercel/project.json`. |
| `VERCEL_PROJECT_ID` | `projectId` from `.vercel/project.json`. |
| `MIGRATION_DATABASE_URL` | The owner on the direct endpoint, from step 1. |

```bash
gh secret set VERCEL_TOKEN --env production --repo "$REPO"
```

## Deploying

Deploys come only from the container workflow's `deploy` job on `main`, which calls [`scripts/deploy.sh`](../scripts/deploy.sh). It verifies the digest's provenance, migrates as the owner with that image, deploys, and waits for health, each step only if the one before succeeded. It deploys nothing if a newer commit has reached `main` since, so a slow older run cannot roll production back. The job runs in the `production` concurrency group, one deploy at a time, and the daily trial sweep below shares it.

The script writes two files into a temporary directory outside the repository and deploys from there, so nothing else is uploaded and neither is committed:

`Dockerfile.vercel`, one line naming the verified digest, never a tag:

```dockerfile
FROM ghcr.io/aszeffs/schoolgrid@sha256:<digest>
```

`vercel.json`, declaring that file a container service and routing every path to it. Without it, Vercel ignores the Dockerfile, builds an empty static site in milliseconds, reports the deployment ready, and serves 404 on every path:

```json
{
  "services": {
    "schoolgrid": { "root": ".", "entrypoint": "Dockerfile.vercel", "runtime": "container" }
  },
  "rewrites": [{ "source": "/(.*)", "destination": { "service": "schoolgrid" } }]
}
```

Then `vercel deploy --prod --env IMAGE_DIGEST=<digest>`, and `/api/health` is retried until it answers `200`.

Vercel copies the image into its own registry and serves it under a new manifest digest. What runs is still what the `FROM` pins; `/api/build-info` reports the GHCR digest, the one the attestations cover.

## Sweeping expired Trial Schools

A Trial School is deleted once expired, whenever the next trial starts, with everything in it, its Audit records included. That is the one exception to Audit records being append-only, and the database holds it: the function refuses any School that is not a Trial School past its expiry, and the service may delete nothing else. The [Trial sweep](../.github/workflows/trial-sweep.yml) workflow is the backstop for a quiet spell: daily, it calls `app.delete_expired_trial_schools()` as the owner, the same function a trial start calls, which deletes only Trial Schools past their expiry. It runs in the `production` environment, for the owner's connection string, and in the `production` concurrency group, so it never overlaps a deploy in either direction. Run it by hand from the Actions tab (**Trial sweep → Run workflow**).

## Checking it

- `GET /api/health` answers `200` with `"database": "reachable"`. The first request after 5 idle minutes wakes both the function and Neon, and takes a few seconds.
- `GET /api/build-info` shows the commit and the digest that was verified.
- The landing page at `/` offers **Start a trial**, which lands in a Trial School as its School Administrator, and *Viewing as* switches to each of the other three roles.
