#!/usr/bin/env bash
#
# Deploy a published image to production on Vercel, by digest, in the only
# order that keeps the supply chain intact:
#
#   1. Verify the digest's build provenance, with the constraints the README
#      gives a consumer. An unverified image is never run against production.
#   2. Migrate the production database with that same image, as the schema
#      owner. The running service holds only the runtime role and never
#      migrates (docs/database-roles.md), so this is the only place it happens.
#   3. Deploy a Dockerfile.vercel whose one line is a FROM by that digest. Vercel
#      pulls those bytes and never builds from source (ADR-0005).
#   4. Retry /api/health on the production URL until it answers 200, long
#      enough to absorb a cold start of the function and of Neon.
#
# Each step runs only if the one before it succeeded. Because the migration runs
# before the new code serves, every migration must stay compatible with the
# code one deploy behind it; see the README's migration notes.
#
# Dockerfile.vercel and vercel.json are written to a temporary directory outside
# the repository and deployed from there. Nothing else is uploaded, so no source
# reaches Vercel, and neither file can be committed by accident.
#
# Nothing is deployed unless the commit is still the head of `main`. Two merges
# can reach this in either order, and the older one arriving last would roll
# production back to an image older than the schema its successor migrated to.
# The head is read once, before anything runs; that is enough only because the
# workflow runs one deploy at a time, in the `production` concurrency group.
#
# Reads from the environment, and refuses to start without them:
#   MIGRATION_DATABASE_URL  the schema owner, on Neon's direct endpoint
#   VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID
#
# Usage: scripts/deploy.sh <image> <digest> <commit-sha> <branch-head-sha> <repository> <production-url>

set -euo pipefail

USAGE="usage: deploy.sh <image> <digest> <commit-sha> <branch-head-sha> <repository> <production-url>"
if [ "$#" -ne 6 ]; then
  echo "$USAGE" >&2
  exit 2
fi
IMAGE_ARG="$1"
DIGEST="$2"
COMMIT_SHA="$3"
BRANCH_HEAD="$4"
REPOSITORY="$5"
PRODUCTION_URL="${6%/}"

# Long enough for a function scaled to zero and a suspended Neon to both wake.
# #93 measured about 3 seconds for the two together; the margin is for a slow day.
DEPLOY_HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-180}"
DEPLOY_HEALTH_INTERVAL_SECONDS="${DEPLOY_HEALTH_INTERVAL_SECONDS:-5}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Every check that needs nothing but the inputs comes first, so a bad input
# fails before the database is touched. A migration that ran for a deploy that
# then could not happen leaves production serving code one schema behind.

# Registries refuse any uppercase in a repository name.
IMAGE="${IMAGE_ARG,,}"

# A digest is the only reference that names bytes. A tag, or the empty string a
# mistyped workflow expression evaluates to, would deploy whatever it resolves
# to by the time Vercel pulls it.
if ! [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  fail "'${DIGEST}' is not a sha256 digest; nothing was deployed"
fi

if ! [[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  fail "'${COMMIT_SHA}' is not a full commit SHA; nothing was deployed"
fi

# An empty head is a lookup that failed, not a newer commit.
if ! [[ "$BRANCH_HEAD" =~ ^[0-9a-f]{40}$ ]]; then
  fail "the branch head '${BRANCH_HEAD}' is not a full commit SHA; nothing was deployed"
fi

if ! [[ "$PRODUCTION_URL" =~ ^https://[^/]+$ ]]; then
  fail "the production URL '${PRODUCTION_URL}' is not an https origin; nothing was deployed"
fi

# A secret the environment does not hold arrives as an empty string, not an
# error.
for name in MIGRATION_DATABASE_URL VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID; do
  if [ -z "${!name:-}" ]; then
    fail "${name} is not set; nothing was deployed"
  fi
done

if [ "$BRANCH_HEAD" != "$COMMIT_SHA" ]; then
  # A notice, so the green job is not read as this commit having shipped.
  echo "::notice::deployed nothing; ${COMMIT_SHA} is no longer the head of main (${BRANCH_HEAD} is)"
  exit 0
fi

REF="${IMAGE}@${DIGEST}"

# --- 1. verify ---------------------------------------------------------------

echo "Verifying the build provenance of ${REF}"
gh attestation verify "oci://${REF}" \
  --repo "$REPOSITORY" \
  --signer-workflow "${REPOSITORY}/.github/workflows/container.yml" \
  --source-ref refs/heads/main \
  --source-digest "$COMMIT_SHA" \
  --deny-self-hosted-runners \
  || fail "the provenance of ${REF} did not verify; nothing was migrated or deployed"

# --- 2. migrate --------------------------------------------------------------

# `-e NAME` with no value hands the container this process's value, so the
# owner's password never appears on a command line.
echo "Migrating production with ${REF}"
docker run --rm -e MIGRATION_DATABASE_URL "$REF" dist/db/migrate-cli.js \
  || fail "the migration failed; nothing was deployed"

# --- 3. deploy ---------------------------------------------------------------

deploy_dir="$(mktemp -d)"
trap 'rm -rf "$deploy_dir"' EXIT

printf 'FROM %s\n' "$REF" > "${deploy_dir}/Dockerfile.vercel"

# Without this, Vercel ignores the Dockerfile, builds an empty static site,
# reports the deployment ready, and serves 404 on every path (#93).
cat > "${deploy_dir}/vercel.json" <<'JSON'
{
  "services": {
    "schoolgrid": { "root": ".", "entrypoint": "Dockerfile.vercel", "runtime": "container" }
  },
  "rewrites": [{ "source": "/(.*)", "destination": { "service": "schoolgrid" } }]
}
JSON

# The digest is a runtime variable on this deployment alone: an image cannot
# carry its own digest, and /api/build-info serves it. VERCEL_TOKEN,
# VERCEL_ORG_ID and VERCEL_PROJECT_ID are read from the environment, so the
# token stays off the command line and no `.vercel` link is needed.
echo "Deploying ${REF} to production"
vercel deploy "$deploy_dir" --prod --yes --env "IMAGE_DIGEST=${DIGEST}" \
  || fail "the Vercel deploy failed"

# --- 4. health ---------------------------------------------------------------

# The production domain, not the deployment's own URL, which Deployment
# Protection puts behind a Vercel sign-in. `vercel deploy --prod` returns once
# the domain points at the new deployment.
health="${PRODUCTION_URL}/api/health"
deadline=$(( $(date +%s) + DEPLOY_HEALTH_TIMEOUT_SECONDS ))
while true; do
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$health" || true)"
  if [ "$status" = "200" ]; then
    echo "ok: ${PRODUCTION_URL} answered 200 on /api/health after deploying ${REF}"
    exit 0
  fi
  echo "waiting: ${health} answered ${status:-nothing}"
  if [ "$(date +%s)" -ge "$deadline" ]; then
    fail "${health} did not answer 200 within ${DEPLOY_HEALTH_TIMEOUT_SECONDS}s; the deploy is live but unhealthy"
  fi
  sleep "$DEPLOY_HEALTH_INTERVAL_SECONDS"
done
