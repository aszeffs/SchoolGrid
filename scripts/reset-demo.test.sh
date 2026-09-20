#!/usr/bin/env bash
#
# Tests for scripts/reset-demo.sh.
#
# The reset is the only thing in this repository that destroys production data
# on purpose, and its order is the whole safety property: the digest production
# runs is read, verified, and only then is the schema dropped. A reset that
# verified after dropping, or skipped the verification, still ends with a
# working demo, so only a test that watches the order can tell the difference.
#
# `curl`, `gh`, `psql` and `docker` are replaced by test doubles on PATH,
# driven by a SCENARIO, each recording its calls to one shared log. Every case
# asserts on which tools ran, with what, and in what order. Nothing here needs
# network, Docker, a database or a GitHub account.
#
# Usage: scripts/reset-demo.test.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
subject="${script_dir}/reset-demo.sh"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

failures=0

IMAGE="ghcr.io/aszeffs/schoolgrid"
SHA="0123456789abcdef0123456789abcdef01234567"
DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
REPO="aszeffs/SchoolGrid"
URL="https://schoolgrid.example.vercel.app"
OWNER_URL="postgresql://owner:owner-secret@db.example/neondb"

# What a freshly seeded demo answers the "only seeded data" query with: one
# School, and nothing that only a visitor or an operator could have made.
CLEAN_COUNTS="1 0 0 0 0"

# --- the doubles ------------------------------------------------------------

mkdir -p "$workdir/bin"

# Answers the three requests the reset makes, by the URL it is given last:
# `/api/build-info` before anything, then `/api/demo` and `/api/session` after
# the reseed. Each writes the body, a newline, then the status code, which is
# what the script asks for with --write-out.
cat > "$workdir/bin/curl" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
echo "curl $*" >> "$STATE/calls"
url="${*: -1}"
args="$*"
# A POST's body arrives on stdin; keeping it lets a case check which account
# was used, and with what, without the password ever being on a command line.
if [ "${args#*--request POST}" != "$args" ]; then
  cat >> "$STATE/posted"
  printf '\n' >> "$STATE/posted"
fi
case "$url" in
  */api/build-info)
    case "$SCENARIO" in
      # curl's own failure: no answer at all, and no body to parse.
      build-info-unreachable) printf '\n000'; exit 7 ;;
      build-info-404) printf 'Not Found\n404' ;;
      build-info-empty) printf '{}\n200' ;;
      build-info-no-digest) printf '{"commit":"%s"}\n200' "$COMMIT" ;;
      build-info-no-commit) printf '{"digest":"%s"}\n200' "$DIGEST" ;;
      build-info-tag) printf '{"commit":"%s","digest":"latest"}\n200' "$COMMIT" ;;
      build-info-html) printf '<!doctype html><title>Vercel</title>\n200' ;;
      *) printf '{"commit":"%s","digest":"%s"}\n200' "$COMMIT" "$DIGEST" ;;
    esac
    ;;
  */api/demo)
    case "$SCENARIO" in
      demo-empty) printf '{"accounts":[]}\n200' ;;
      demo-three)
        printf '{"accounts":[{"role":"school_administrator","username":"demo.administrator","password":"a"},{"role":"faculty","username":"demo.faculty","password":"b"},{"role":"student","username":"demo.student","password":"c"}]}\n200'
        ;;
      demo-unreachable) printf '\n000'; exit 7 ;;
      *)
        printf '{"accounts":[{"role":"school_administrator","username":"demo.administrator","password":"a"},{"role":"faculty","username":"demo.faculty","password":"b"},{"role":"student","username":"demo.student","password":"c"},{"role":"guardian","username":"demo.guardian","password":"d"}]}\n200'
        ;;
    esac
    ;;
  */api/session)
    case "$SCENARIO" in
      # The third account is the one that cannot sign in, so a case also shows
      # the reset does not stop at the first account and call that a pass.
      signin-fails)
        count=$(( $(cat "$STATE/session-count" 2>/dev/null || echo 0) + 1 ))
        echo "$count" > "$STATE/session-count"
        if [ "$count" -eq 3 ]; then printf '{"status":"refused"}\n403'; else printf '{"expiresAt":"2026-01-01T00:00:00.000Z"}\n201'; fi
        ;;
      *) printf '{"token":"t","expiresAt":"2026-01-01T00:00:00.000Z"}\n201' ;;
    esac
    ;;
  *) echo "the double was asked for an unexpected URL: ${url}" >&2; exit 99 ;;
esac
DOUBLE

cat > "$workdir/bin/gh" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >> "$STATE/calls"
if [ "$SCENARIO" = "verify-fails" ]; then
  echo "Error: verifying with issuer \"sigstore.dev\": no matching attestations" >&2
  exit 1
fi
echo "Loaded 1 attestation from GitHub API"
DOUBLE

# Distinguishes the three ways the reset runs psql — the drop, the seed, and
# the check — by what it is given, and records each apart from the call log.
cat > "$workdir/bin/psql" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
echo "psql $*" >> "$STATE/calls"
kind=check
for arg in "$@"; do
  case "$arg" in
    --file) kind=seed ;;
    *DROP*) kind=drop; printf '%s\n' "$arg" > "$STATE/drop-sql" ;;
  esac
done
if [ "$kind" = "seed" ]; then
  # The path is the argument after --file. Its contents are recorded so a case
  # can show the repository's own seed, not some other file, was applied.
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--file" ]; then printf '%s\n' "$arg" > "$STATE/seed-file"; fi
    prev="$arg"
  done
fi
echo "$kind" >> "$STATE/psql-kinds"
case "${SCENARIO}:${kind}" in
  drop-fails:drop) echo 'ERROR:  must be owner of schema app' >&2; exit 1 ;;
  seed-fails:seed) echo 'ERROR:  duplicate key value violates unique constraint "school_pkey"' >&2; exit 1 ;;
  check-fails:check) printf '%s\n' "2 17 3 1 0" ;;
  check-unreadable:check) echo 'ERROR:  relation "app.school" does not exist' >&2; exit 1 ;;
  *:check) printf '%s\n' "1 0 0 0 0" ;;
  *) : ;;
esac
DOUBLE

cat > "$workdir/bin/docker" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >> "$STATE/calls"
# What the container would see. Recorded apart from the call log so a case can
# check the owner's URL reached it without it ever being on a command line.
echo "${MIGRATION_DATABASE_URL-}" > "$STATE/migration-url"
if [ "$SCENARIO" = "migrate-fails" ]; then
  echo "migration 0042_widen.sql failed: column \"x\" does not exist" >&2
  exit 1
fi
echo "migrations applied"
DOUBLE

chmod +x "$workdir/bin/"*
export PATH="$workdir/bin:$PATH"

# --- running a case ---------------------------------------------------------

current=""
output=""
code=0
state=""

run_case() {
  local description="$1"
  local scenario="$2"
  local url="${3-$URL}"
  local unset_var="${4-}"

  current="$description"
  state="$workdir/state/$description"
  mkdir -p "$state"
  : > "$state/calls"
  : > "$state/posted"

  code=0
  output="$(
    export SCENARIO="$scenario" STATE="$state" COMMIT="$SHA" DIGEST="$DIGEST"
    export MIGRATION_DATABASE_URL="$OWNER_URL"
    if [ -n "$unset_var" ]; then unset "$unset_var"; fi
    bash "$subject" "$IMAGE" "$REPO" "$url" 2>&1
  )" || code=$?
}

report() {
  echo "FAIL: ${current}" >&2
  echo "  $1" >&2
  echo "$output" | sed 's/^/  | /' >&2
  echo "  calls:" >&2
  sed 's/^/  > /' "$state/calls" >&2
  failures=$((failures + 1))
}

expect_code() {
  if [ "$code" -ne "$1" ]; then report "expected exit $1, got ${code}"; fi
}

expect_output() {
  if ! echo "$output" | grep -qF -- "$1"; then report "the output never said: $1"; fi
}

expect_no_call_to() {
  if grep -q "^$1 " "$state/calls"; then report "$1 was called"; fi
}

expect_no_calls() {
  if [ -s "$state/calls" ]; then report "something was called"; fi
}

expect_call() {
  if ! grep -qxF -- "$1" "$state/calls"; then report "never called: $1"; fi
}

# Nothing destructive ran: neither the drop, nor the migration that would
# follow it, nor the seed.
expect_nothing_dropped() {
  if [ -f "$state/psql-kinds" ] && grep -qx drop "$state/psql-kinds"; then report "the schema was dropped"; fi
  expect_no_call_to docker
  if [ -f "$state/psql-kinds" ] && grep -qx seed "$state/psql-kinds"; then report "the seed ran"; fi
}

# The line the first call matching a pattern was logged on, so a case can say
# one step happened before another rather than only that both happened.
line_of() {
  grep -n -- "$1" "$state/calls" | head -n 1 | cut -d : -f 1
}

expect_before() {
  local before after
  before="$(line_of "$1")"
  after="$(line_of "$2")"
  if [ -z "$before" ]; then report "never called: $1"; return; fi
  if [ -z "$after" ]; then report "never called: $2"; return; fi
  if [ "$before" -ge "$after" ]; then report "'$1' did not come before '$2'"; fi
}

# --- the cases --------------------------------------------------------------

run_case "a clean reset reads, verifies, drops, migrates, seeds, then checks" ok
expect_code 0
expect_output "ok: the demo was reset"
kinds="$(cat "$state/psql-kinds" 2>/dev/null | paste -sd ' ' -)"
if [ "$kinds" != "drop seed check" ]; then
  report "psql ran as '${kinds}', not 'drop seed check'"
fi

# The order is the security property. Reading the digest, verifying it, and
# only then dropping: each of the three must come before the next.
run_case "the digest is read and verified before anything is dropped" ok
expect_before "/api/build-info" "gh attestation verify"
expect_before "gh attestation verify" "DROP SCHEMA"
expect_before "DROP SCHEMA" "docker run"
expect_before "docker run" "--file"

# The flags are the check. Without them a statement signed by any workflow in
# the repository, from any commit or ref, would pass as provenance.
run_case "verification uses the README's constraints on the digest production runs" ok
expect_call "gh attestation verify oci://${IMAGE}@${DIGEST} --repo ${REPO} --signer-workflow ${REPO}/.github/workflows/container.yml --source-ref refs/heads/main --source-digest ${SHA} --deny-self-hosted-runners"

# AC: a digest that fails verification drops nothing.
run_case "a failed verification drops nothing" verify-fails
expect_code 1
expect_output "no matching attestations"
expect_nothing_dropped

# AC: a missing or unreadable /api/build-info drops nothing. Each way it can be
# missing is its own case, because each fails at a different point.
run_case "production not answering at all drops nothing" build-info-unreachable
expect_code 1
expect_output "build-info"
expect_no_call_to gh
expect_nothing_dropped

run_case "a 404 from build-info drops nothing" build-info-404
expect_code 1
expect_output "404"
expect_no_call_to gh
expect_nothing_dropped

run_case "a build-info with neither field drops nothing" build-info-empty
expect_code 1
expect_no_call_to gh
expect_nothing_dropped

run_case "a build-info with no digest drops nothing" build-info-no-digest
expect_code 1
expect_output "digest"
expect_no_call_to gh
expect_nothing_dropped

# Without the commit there is nothing to hold the attestation's source to, and
# a statement about any commit in the repository would pass.
run_case "a build-info with no commit drops nothing" build-info-no-commit
expect_code 1
expect_output "commit"
expect_no_call_to gh
expect_nothing_dropped

run_case "a tag where the digest should be drops nothing" build-info-tag
expect_code 1
expect_output "not a sha256 digest"
expect_no_call_to gh
expect_nothing_dropped

# What a Vercel error page, or a deployment behind Deployment Protection,
# answers with. It parses as neither field, and must not read as an empty one.
run_case "an HTML page where build-info should be drops nothing" build-info-html
expect_code 1
expect_no_call_to gh
expect_nothing_dropped

# The drop is a single statement as the owner, and it takes the migration
# record with it: that table is in `public`, so it survives the schema and
# would otherwise leave the migration with nothing to apply.
run_case "the drop takes the app schema and the migration record together" ok
if ! grep -qF "DROP SCHEMA IF EXISTS app CASCADE" "$state/drop-sql"; then report "the drop did not drop the app schema"; fi
if ! grep -qF "public.schema_migrations" "$state/drop-sql"; then report "the drop left the migration record behind"; fi

run_case "a failed drop migrates and seeds nothing" drop-fails
expect_code 1
expect_output "must be owner of schema app"
expect_no_call_to docker
if grep -qx seed "$state/psql-kinds"; then report "the seed ran"; fi

# The migration runs the digest just verified, by digest, never a tag.
run_case "the migration runs the verified digest" ok
expect_call "docker run --rm -e MIGRATION_DATABASE_URL ${IMAGE}@${DIGEST} dist/db/migrate-cli.js"

# By name, so the owner's password is in the container's environment and not in
# the process list or the job log.
run_case "the owner's URL reaches the migration only through the environment" ok
if [ "$(cat "$state/migration-url")" != "$OWNER_URL" ]; then report "the container did not receive MIGRATION_DATABASE_URL"; fi
if grep -qF "owner-secret" <<<"$output"; then report "the owner's password was printed"; fi

run_case "a failed migration seeds nothing" migrate-fails
expect_code 1
expect_output "0042_widen.sql failed"
if grep -qx seed "$state/psql-kinds"; then report "the seed ran"; fi

# The repository's own seed, and stopping on the first error, so a half-seeded
# demo is never left behind reporting success.
run_case "the seed is the repository's, applied with ON_ERROR_STOP" ok
if [ "$(cat "$state/seed-file")" != "${repo_root}/demo/seed.sql" ]; then
  report "the seed applied was '$(cat "$state/seed-file")'"
fi
if ! grep -E '^psql ' "$state/calls" | grep -qF -- "ON_ERROR_STOP=1"; then report "psql was not given ON_ERROR_STOP=1"; fi

run_case "a failed seed fails the reset" seed-fails
expect_code 1
expect_output "duplicate key value"

# AC: after a reset the database holds only seeded data. One School, and none
# of the rows only a visitor or an operator makes.
run_case "leftover data fails the reset" check-fails
expect_code 1
expect_output "$CLEAN_COUNTS"
expect_output "2 17 3 1 0"

run_case "a database the check cannot read fails the reset" check-unreadable
expect_code 1
expect_output "does not exist"

# AC: after a reset all four demo accounts sign in. Against the live service,
# so this covers the runtime role's grants, which the drop took with the schema
# and the migration put back.
run_case "every published demo account signs in" ok
for username in demo.administrator demo.faculty demo.student demo.guardian; do
  if ! grep -qF "\"username\":\"${username}\"" "$state/posted"; then report "${username} never signed in"; fi
done
if ! grep -qF '"session":"bearer"' "$state/posted"; then report "the sign-in did not ask for a bearer session"; fi
if grep -E '^curl ' "$state/calls" | grep -qF "password"; then report "a password appeared on a command line"; fi

run_case "an account that cannot sign in fails the reset" signin-fails
expect_code 1
expect_output "demo.student"
expect_output "403"

run_case "a demo publishing fewer than four accounts fails the reset" demo-three
expect_code 1
expect_output "4"

run_case "a demo publishing no accounts fails the reset" demo-empty
expect_code 1

run_case "production not answering the demo route fails the reset" demo-unreachable
expect_code 1

# Checks that need nothing but the inputs come first, so a bad input fails
# before the schema is dropped rather than after.
run_case "a non-https production URL is refused before anything runs" ok "http://schoolgrid.example.vercel.app"
expect_code 1
expect_output "https"
expect_no_calls

run_case "a production URL with a path is refused before anything runs" ok "https://schoolgrid.example.vercel.app/demo"
expect_code 1
expect_no_calls

run_case "a trailing slash on the production URL is dropped" ok "${URL}/"
expect_code 0
expect_call "curl --silent --max-time 15 --write-out \\n%{http_code} ${URL}/api/build-info"

run_case "a missing MIGRATION_DATABASE_URL is refused before anything runs" ok "$URL" MIGRATION_DATABASE_URL
expect_code 1
expect_output "MIGRATION_DATABASE_URL"
expect_no_calls

# --- the workflow -----------------------------------------------------------
#
# AC: the reset and deploy jobs share a concurrency group and never run at
# once. That is a property of the workflow files, not of the script, and the
# only thing standing between a reset dropping the schema a deploy is migrating.

current="the reset and the deploy share one concurrency group"
state="$workdir/state/workflow"
mkdir -p "$state"
: > "$state/calls"
output=""

reset_workflow="${repo_root}/.github/workflows/demo-reset.yml"
container_workflow="${repo_root}/.github/workflows/container.yml"

if [ ! -f "$reset_workflow" ]; then
  report "there is no ${reset_workflow}"
else
  # Both the group and `cancel-in-progress: false`: a reset cancelled halfway
  # would leave the demo dropped but never seeded.
  if ! grep -qE '^ +group: production$' "$reset_workflow"; then
    report "the reset workflow is not in the production concurrency group"
  fi
  if ! grep -qE '^ +cancel-in-progress: false$' "$reset_workflow"; then
    report "the reset workflow does not refuse cancellation"
  fi
  if ! grep -qE '^ +schedule:$' "$reset_workflow"; then
    report "the reset workflow is not scheduled"
  fi
  if ! grep -qE '^ +workflow_dispatch:$' "$reset_workflow"; then
    report "the reset workflow cannot be run by hand"
  fi
  # The same environment as the deploy, which is what holds the owner's
  # connection string and is reachable from `main` alone.
  if ! grep -qE '^ +name: production$' "$reset_workflow"; then
    report "the reset workflow does not run in the production environment"
  fi
fi

if ! grep -qE '^ +group: production$' "$container_workflow"; then
  report "the deploy job is no longer in the production concurrency group"
fi

# The script's own tests run in CI, like every other script here, so a reset
# script that stopped verifying before dropping fails the pull request that
# broke it rather than a night in production.
current="the reset script's tests run in CI"
if ! grep -qF "scripts/reset-demo.test.sh" "$container_workflow"; then
  report "scripts/reset-demo.test.sh is not run by the container workflow"
fi

# --- verdict ----------------------------------------------------------------

echo
if [ "$failures" -gt 0 ]; then
  echo "${failures} assertion(s) failed" >&2
  exit 1
fi
echo "all tests passed"
