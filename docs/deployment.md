# Deployment

The public demo runs on Vercel's Hobby plan against a Neon Postgres database. Production runs the exact image `main` published, verified and deployed by digest from CI alone ([ADR-0005](adr/0005-production-runs-the-verified-image.md)). This page is the one-time setup: follow it top to bottom to rebuild the deployment from nothing.

It holds invented data only. Hobby is for non-commercial, personal use, and the demo's sign-ins are public.

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

## 3. The first migrate and seed

Migrate with the verified image, as the owner, exactly as the deploy job will:

```bash
MIGRATION_DATABASE_URL="$OWNER_URL" docker run --rm -e MIGRATION_DATABASE_URL \
  "$IMAGE@$DIGEST" dist/db/migrate-cli.js
```

Then seed the demo School from the repository. The seed is never in the image, and it fails rather than seed twice:

```bash
psql "$OWNER_URL" -X -v ON_ERROR_STOP=1 --file demo/seed.sql
```

The seed creates a School Administrator, Faculty, Student and Guardian, whose sign-ins the demo publishes. It creates no Platform Administrator, and none is ever published: a Platform Administrator is made by hand, as the owner ([docs/database-roles.md](database-roles.md#making-a-platform-administrator)), and the demo has no need of one.

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
| `DEMO_MODE` | `true` |
| `LOG_LEVEL` | `info` |

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

Deploys come only from the container workflow on `main`, after the image's provenance is verified. The job writes two files, neither of them committed:

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

## Checking it

- `GET /api/health` answers `200` with `"database": "reachable"`. The first request after 5 idle minutes wakes both the function and Neon, and takes a few seconds.
- `GET /api/build-info` shows the commit and the digest that was verified.
- The sign-in page offers **Try a role**, and each of the four roles signs in.
