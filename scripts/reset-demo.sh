#!/usr/bin/env bash
#
# Reset the public demo's data, nightly, to what demo/seed.sql describes.
#
# The demo publishes a sign-in for every School role, so anyone may change
# anything in it. This puts it back, in the only order that keeps the supply
# chain intact:
#
#   1. Read from the live /api/build-info the digest production actually runs.
#      Nothing here is taken from a workflow expression or a tag: what is about
#      to migrate the database must be what is already serving it.
#   2. Verify that digest's build provenance, with the constraints the README
#      gives a consumer. An unverified image never reaches the database.
#   3. As the schema owner, drop the `app` schema and the migration record.
#   4. Migrate with that same image, as scripts/deploy.sh does.
#   5. Apply demo/seed.sql, as the owner.
#   6. Check the database holds only seeded data, then sign in as every account
#      the demo publishes.
#
# Each step runs only if the one before it succeeded, and steps 1 and 2 come
# before anything is dropped: a digest that does not verify, and a production
# that cannot say what it runs, both leave the demo exactly as it was.
#
# Dropping the schema deletes Audit records. That is deliberate, and true of
# the demo database alone: the trigger that refuses TRUNCATE on
# app.audit_record does not stop a DROP SCHEMA, and only the owner can drop it.
# The demo's Audit records are invented, made by visitors trying a role, and
# keeping one night's worth in a database anyone can write to buys nothing.
#
# The migration record lives in `public.schema_migrations`, not in `app`, so it
# survives the schema it describes. Left behind, it would tell the migration
# every migration had already run and the demo would come back to an empty
# database. It is dropped with the schema, in one transaction, so the two can
# never disagree.
#
# Reads from the environment, and refuses to start without it:
#   MIGRATION_DATABASE_URL  the schema owner, on Neon's direct endpoint
#
# Usage: scripts/reset-demo.sh <image> <repository> <production-url>

set -euo pipefail

USAGE="usage: reset-demo.sh <image> <repository> <production-url>"
if [ "$#" -ne 3 ]; then
  echo "$USAGE" >&2
  exit 2
fi
IMAGE_ARG="$1"
REPOSITORY="$2"
PRODUCTION_URL="${3%/}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
SEED_FILE="${repo_root}/demo/seed.sql"

RESET_HTTP_TIMEOUT_SECONDS="${RESET_HTTP_TIMEOUT_SECONDS:-15}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- 0. the inputs -----------------------------------------------------------
#
# Everything that needs nothing but the arguments and the environment is
# checked first, so a mistyped input fails before the schema is dropped rather
# than after, when the demo would be down until someone noticed.

# Registries refuse any uppercase in a repository name.
IMAGE="${IMAGE_ARG,,}"

if ! [[ "$REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  fail "'${REPOSITORY}' is not an owner/name repository; nothing was dropped"
fi

if ! [[ "$PRODUCTION_URL" =~ ^https://[^/]+$ ]]; then
  fail "the production URL '${PRODUCTION_URL}' is not an https origin; nothing was dropped"
fi

# A secret the environment does not hold arrives as an empty string, not an
# error.
if [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
  fail "MIGRATION_DATABASE_URL is not set; nothing was dropped"
fi

if [ ! -f "$SEED_FILE" ]; then
  fail "there is no seed at ${SEED_FILE}; nothing was dropped"
fi

# The owner's connection string is an argument to psql, which no environment
# variable can replace: libpq expands a URI only where one is passed directly,
# not through PGDATABASE. The migration still takes it through the environment
# (step 4), because there it can. On a GitHub-hosted runner this process list
# is the job's own, and the value is a secret Actions masks in the log.
psql_owner() {
  psql "$MIGRATION_DATABASE_URL" --no-psqlrc --quiet --set ON_ERROR_STOP=1 "$@"
}

# --- HTTP --------------------------------------------------------------------

http_status=""
http_body=""

# Leaves the body in `http_body` and the code in `http_status`, and returns
# what curl returned, so a request that never got an answer is told apart from
# one that got a bad one.
fetch() {
  local url="$1"
  shift
  local raw="" rc=0
  raw="$(curl --silent --max-time "$RESET_HTTP_TIMEOUT_SECONDS" --write-out '\n%{http_code}' "$@" "$url")" || rc=$?
  if [[ "$raw" == *$'\n'* ]]; then
    http_status="${raw##*$'\n'}"
    http_body="${raw%$'\n'*}"
  else
    http_status=""
    http_body="$raw"
  fi
  return "$rc"
}

# One string field of a flat JSON object. The bodies read here are small and
# fixed in shape — two fields from /api/build-info, and the demo's own
# sign-ins — and this runs where a `jq` is one more thing to depend on.
# A field the body does not hold is empty, not an error: whether its absence
# is fatal is for the caller to say, and here it always is.
json_string_field() {
  local match=""
  match="$(printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1)" || true
  [ -n "$match" ] || return 0
  printf '%s' "$match" | sed 's/.*:[[:space:]]*"\(.*\)"$/\1/'
}

# --- 1. what production runs -------------------------------------------------

echo "Reading ${PRODUCTION_URL}/api/build-info"
fetch "${PRODUCTION_URL}/api/build-info" \
  || fail "${PRODUCTION_URL}/api/build-info could not be read (curl exited $?); nothing was dropped"

if [ "$http_status" != "200" ]; then
  fail "${PRODUCTION_URL}/api/build-info answered ${http_status:-nothing}; nothing was dropped"
fi

DIGEST="$(json_string_field "$http_body" digest)"
COMMIT="$(json_string_field "$http_body" commit)"

# Both fields are optional in the service, absent in local development. In
# production the deploy supplies the digest and the build bakes in the commit,
# so one missing means this is not the deployment it is meant to be.
if [ -z "$DIGEST" ]; then
  fail "build-info served no digest, so there is nothing to verify; nothing was dropped"
fi
if [ -z "$COMMIT" ]; then
  fail "build-info served no commit, so the provenance could not be held to one; nothing was dropped"
fi

# A digest is the only reference that names bytes.
if ! [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  fail "build-info served '${DIGEST}', which is not a sha256 digest; nothing was dropped"
fi
if ! [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  fail "build-info served '${COMMIT}', which is not a full commit SHA; nothing was dropped"
fi

REF="${IMAGE}@${DIGEST}"

# --- 2. verify ---------------------------------------------------------------

# The same constraints scripts/deploy.sh verifies under. Without them a
# statement signed by any workflow in the repository, from any commit or ref,
# would pass as provenance.
echo "Verifying the build provenance of ${REF}"
gh attestation verify "oci://${REF}" \
  --repo "$REPOSITORY" \
  --signer-workflow "${REPOSITORY}/.github/workflows/container.yml" \
  --source-ref refs/heads/main \
  --source-digest "$COMMIT" \
  --deny-self-hosted-runners \
  || fail "the provenance of ${REF} did not verify; nothing was dropped"

# --- 3. drop -----------------------------------------------------------------

# One transaction, so the schema and the record of what migrated it go together
# or not at all. `lock_timeout` so a long-running query in the demo makes this
# fail in half a minute rather than hold a lock the whole service queues behind.
echo "Dropping the demo's schema"
psql_owner --command "
BEGIN;
SET LOCAL lock_timeout = '30s';
DROP SCHEMA IF EXISTS app CASCADE;
DROP TABLE IF EXISTS public.schema_migrations;
COMMIT;
" || fail "the drop failed; the demo is unchanged"

# --- 4. migrate --------------------------------------------------------------

# `-e NAME` with no value hands the container this process's value, so the
# owner's password never appears on a command line here.
echo "Migrating the demo with ${REF}"
docker run --rm -e MIGRATION_DATABASE_URL "$REF" dist/db/migrate-cli.js \
  || fail "the migration failed; the demo is dropped and not seeded"

# --- 5. seed -----------------------------------------------------------------

echo "Seeding the demo from demo/seed.sql"
psql_owner --file "$SEED_FILE" \
  || fail "the seed failed; the demo is migrated and not seeded"

# --- 6. check ----------------------------------------------------------------

# Only seeded data: the one invented School, and none of the rows that only a
# visitor or an operator makes. The seed writes no Audit record and starts no
# Session, so anything here is something the drop was supposed to have taken.
echo "Checking the demo holds only seeded data"
EXPECTED_COUNTS="1 0 0 0 0"
counts="$(psql_owner --tuples-only --no-align --command "
SELECT (SELECT count(*) FROM app.school) || ' ' ||
       (SELECT count(*) FROM app.audit_record) || ' ' ||
       (SELECT count(*) FROM app.user_session) || ' ' ||
       (SELECT count(*) FROM app.platform_administrator) || ' ' ||
       (SELECT count(*) FROM app.invitation)
")" || fail "the demo could not be counted after seeding"
counts="$(printf '%s' "$counts" | tr -d '\r' | tr -s ' \n' ' ' | sed 's/^ *//; s/ *$//')"
if [ "$counts" != "$EXPECTED_COUNTS" ]; then
  fail "the demo holds more than seeded data: schools, audit records, sessions, platform administrators, invitations were '${counts}', not '${EXPECTED_COUNTS}'"
fi

# Every account the demo publishes signs in, against the running service. This
# is the end-to-end check the rest cannot make: it goes through the runtime
# role, whose grants the drop took with the schema and the migration put back,
# and through the seeded password hashes.
echo "Signing in as every account the demo publishes"
fetch "${PRODUCTION_URL}/api/demo" \
  || fail "${PRODUCTION_URL}/api/demo could not be read after seeding"
if [ "$http_status" != "200" ]; then
  fail "${PRODUCTION_URL}/api/demo answered ${http_status:-nothing} after seeding"
fi

accounts="$(printf '%s' "$http_body" \
  | grep -o '"username"[[:space:]]*:[[:space:]]*"[^"]*"[[:space:]]*,[[:space:]]*"password"[[:space:]]*:[[:space:]]*"[^"]*"' \
  || true)"

# One for each School role. Fewer means the seed left an account out, or the
# service is not in demo mode and is publishing none.
EXPECTED_ACCOUNTS=4
found="$(printf '%s' "$accounts" | grep -c '"username"' || true)"
if [ "$found" -ne "$EXPECTED_ACCOUNTS" ]; then
  fail "the demo publishes ${found} accounts, not ${EXPECTED_ACCOUNTS}"
fi

while IFS= read -r account; do
  [ -n "$account" ] || continue
  username="$(json_string_field "{$account}" username)"
  password="$(json_string_field "{$account}" password)"
  # The credentials go over stdin, so neither is in the process list, and a
  # bearer session, so no cookie is asked for and the public-origin check that
  # guards one does not apply to a sign-in made from here.
  fetch "${PRODUCTION_URL}/api/session" \
    --request POST \
    --header "content-type: application/json" \
    --data-binary @- \
    <<< "{\"username\":\"${username}\",\"password\":\"${password}\",\"session\":\"bearer\"}" \
    || fail "signing in as ${username} got no answer"
  if [ "$http_status" != "201" ]; then
    fail "signing in as ${username} answered ${http_status:-nothing}, not 201; the demo is seeded but unusable"
  fi
  echo "  ${username} signed in"
done <<< "$accounts"

echo "ok: the demo was reset to demo/seed.sql, running ${REF}"
