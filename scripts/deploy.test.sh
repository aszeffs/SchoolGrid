#!/usr/bin/env bash
#
# Tests for scripts/deploy.sh.
#
# The deploy is the step that puts bytes in front of visitors and changes the
# production schema, and its order is the security property: nothing is
# migrated before the digest's provenance is verified, and nothing is deployed
# before the migration has succeeded. A deploy that skips a step, or runs one
# early, still ends with a healthy site, so only a test that watches the order
# can tell.
#
# `gh`, `docker`, `vercel` and `curl` are replaced by test doubles driven by a
# SCENARIO, and each records its calls to one shared log, so each case asserts
# on which tools ran, with what, and in what order. Nothing here needs network,
# Docker or a Vercel account.
#
# Usage: scripts/deploy.test.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
subject="${script_dir}/deploy.sh"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

failures=0

IMAGE="ghcr.io/aszeffs/schoolgrid"
SHA="0123456789abcdef0123456789abcdef01234567"
DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
REPO="aszeffs/SchoolGrid"
URL="https://schoolgrid.example.vercel.app"
OWNER_URL="postgresql://owner:owner-secret@db.example/neondb"

# --- the doubles ------------------------------------------------------------

mkdir -p "$workdir/bin"

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

cat > "$workdir/bin/docker" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >> "$STATE/calls"
# What the container would see. Recorded apart from the call log so a case can
# check the owner's URL reached it without it ever appearing on a command line.
echo "${MIGRATION_DATABASE_URL-}" > "$STATE/migration-url"
if [ "$SCENARIO" = "migrate-fails" ]; then
  echo "migration 0042_widen.sql failed: column \"x\" does not exist" >&2
  exit 1
fi
echo "migrations applied"
DOUBLE

cat > "$workdir/bin/vercel" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
echo "vercel $*" >> "$STATE/calls"
# The directory being deployed is the first argument after `deploy`. A copy of
# what it held, and where it was, is kept for the cases to inspect.
dir="$2"
echo "$dir" > "$STATE/deployed-from"
mkdir -p "$STATE/deployed"
cp -R "$dir"/. "$STATE/deployed/"
if [ "$SCENARIO" = "deploy-fails" ]; then
  echo "Error: The specified token is not valid." >&2
  exit 1
fi
echo "https://schoolgrid-abc123.vercel.app"
DOUBLE

cat > "$workdir/bin/curl" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
echo "curl $*" >> "$STATE/calls"
count=$(( $(cat "$STATE/curl-count" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$STATE/curl-count"
case "$SCENARIO" in
  never-healthy) printf '503' ;;
  # A cold start: no answer at all, then an error, then healthy.
  cold-start)
    if [ "$count" -eq 1 ]; then printf '000'; exit 28; fi
    if [ "$count" -eq 2 ]; then printf '503'; exit 0; fi
    printf '200'
    ;;
  *) printf '200' ;;
esac
DOUBLE

chmod +x "$workdir/bin/"*
export PATH="$workdir/bin:$PATH"

# --- running a case ---------------------------------------------------------

current=""
output=""
code=0
state=""

# The environment the workflow step provides. A case can unset one by naming it.
run_case() {
  local description="$1"
  local scenario="$2"
  local digest="${3-$DIGEST}"
  local sha="${4-$SHA}"
  local head="${5-$SHA}"
  local url="${6-$URL}"
  local unset_var="${7-}"

  current="$description"
  state="$workdir/state/$description"
  mkdir -p "$state"
  : > "$state/calls"

  code=0
  output="$(
    export SCENARIO="$scenario" STATE="$state"
    export MIGRATION_DATABASE_URL="$OWNER_URL"
    export VERCEL_TOKEN=token VERCEL_ORG_ID=team_x VERCEL_PROJECT_ID=prj_x
    export DEPLOY_HEALTH_TIMEOUT_SECONDS=2 DEPLOY_HEALTH_INTERVAL_SECONDS=0
    if [ -n "$unset_var" ]; then unset "$unset_var"; fi
    bash "$subject" "$IMAGE" "$digest" "$sha" "$head" "$REPO" "$url" 2>&1
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

# The tools in the order they were first called, one word each.
tool_order() {
  cut -d ' ' -f 1 "$state/calls" | uniq | paste -sd ' ' -
}

# --- the cases --------------------------------------------------------------

run_case "a clean deploy verifies, migrates, deploys, then waits for health" ok
expect_code 0
if [ "$(tool_order)" != "gh docker vercel curl" ]; then
  report "the order was '$(tool_order)', not 'gh docker vercel curl'"
fi
expect_output "ok: ${URL} answered 200"

# The flags are the checks. Without them a statement signed by any workflow in
# the repository, from any commit or ref, would pass as provenance.
run_case "verification uses the README's constraints on the digest" ok
expect_call "gh attestation verify oci://${IMAGE}@${DIGEST} --repo ${REPO} --signer-workflow ${REPO}/.github/workflows/container.yml --source-ref refs/heads/main --source-digest ${SHA} --deny-self-hosted-runners"

run_case "a failed verification migrates and deploys nothing" verify-fails
expect_code 1
expect_output "no matching attestations"
expect_no_call_to docker
expect_no_call_to vercel
expect_no_call_to curl

# The migration runs the image just verified, by digest, never a tag.
run_case "the migration runs the verified digest" ok
expect_call "docker run --rm -e MIGRATION_DATABASE_URL ${IMAGE}@${DIGEST} dist/db/migrate-cli.js"

# By name, so the owner's password is in the container's environment and not in
# the process list or the job log.
run_case "the owner's URL reaches the migration only through the environment" ok
if [ "$(cat "$state/migration-url")" != "$OWNER_URL" ]; then report "the container did not receive MIGRATION_DATABASE_URL"; fi
if grep -qF "owner-secret" "$state/calls"; then report "the owner's password appeared on a command line"; fi

run_case "a failed migration deploys nothing" migrate-fails
expect_code 1
expect_output "0042_widen.sql failed"
expect_no_call_to vercel
expect_no_call_to curl

run_case "the deploy is to production, with the digest as a runtime variable" ok
if ! grep -E '^vercel deploy ' "$state/calls" | grep -qF -- "--prod"; then report "vercel deploy was not given --prod"; fi
if ! grep -E '^vercel deploy ' "$state/calls" | grep -qF -- "--env IMAGE_DIGEST=${DIGEST}"; then report "vercel deploy was not given --env IMAGE_DIGEST=${DIGEST}"; fi

run_case "Dockerfile.vercel is one FROM naming the digest" ok
if [ "$(cat "$state/deployed/Dockerfile.vercel")" != "FROM ${IMAGE}@${DIGEST}" ]; then
  report "Dockerfile.vercel was not exactly 'FROM ${IMAGE}@${DIGEST}'"
  sed 's/^/  | /' "$state/deployed/Dockerfile.vercel" >&2
fi

# Without the vercel.json, Vercel ignores the Dockerfile, reports the deploy
# ready, and serves a 404 on every path (#93).
run_case "vercel.json routes every path to the container service" ok
json="$state/deployed/vercel.json"
if ! grep -qF '"entrypoint": "Dockerfile.vercel"' "$json"; then report "vercel.json does not name Dockerfile.vercel"; fi
if ! grep -qF '"runtime": "container"' "$json"; then report "vercel.json does not declare a container service"; fi
if ! grep -qF '{ "source": "/(.*)", "destination": { "service": "schoolgrid" } }' "$json"; then report "vercel.json does not rewrite every path to the service"; fi

# Only those two files are uploaded, from a directory outside the repository, so
# neither can be committed and no source reaches Vercel to be built from.
run_case "the deploy uploads only the two generated files, from outside the repository" ok
deployed_from="$(cat "$state/deployed-from")"
case "$deployed_from" in
  "$repo_root"|"$repo_root"/*) report "deployed from inside the repository: ${deployed_from}" ;;
esac
if [ "$(cd "$state/deployed" && ls -A | paste -sd ' ' -)" != "Dockerfile.vercel vercel.json" ]; then
  report "the deployed directory held: $(cd "$state/deployed" && ls -A | paste -sd ' ' -)"
fi

run_case "a failed deploy fails and checks no health" deploy-fails
expect_code 1
expect_no_call_to curl

run_case "health is retried through a cold start" cold-start
expect_code 0
expect_output "answered 200"
expect_call "curl --silent --output /dev/null --write-out %{http_code} --max-time 10 ${URL}/api/health"

run_case "production never answering 200 fails the deploy" never-healthy
expect_code 1
expect_output "did not answer 200"

# A digest is the only name that pins bytes. A tag, or an empty value from a
# mistyped expression, would deploy whatever it resolves to by then.
run_case "a tag in place of a digest is refused before anything runs" ok "latest"
expect_code 1
expect_output "not a sha256 digest"
expect_no_calls

run_case "an empty digest is refused before anything runs" ok ""
expect_code 1
expect_no_calls

run_case "an abbreviated commit SHA is refused before anything runs" ok "$DIGEST" "${SHA:0:7}"
expect_code 1
expect_output "not a full commit SHA"
expect_no_calls

run_case "a non-https production URL is refused before anything runs" ok "$DIGEST" "$SHA" "$SHA" "http://schoolgrid.example.vercel.app"
expect_code 1
expect_no_calls

run_case "a trailing slash on the production URL is dropped" ok "$DIGEST" "$SHA" "$SHA" "${URL}/"
expect_code 0
expect_call "curl --silent --output /dev/null --write-out %{http_code} --max-time 10 ${URL}/api/health"

# A secret the environment does not hold is an empty string in a workflow, and
# found missing only at the deploy it would leave the database migrated for an
# image that never shipped.
for name in MIGRATION_DATABASE_URL VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID; do
  run_case "a missing ${name} is refused before anything runs" ok "$DIGEST" "$SHA" "$SHA" "$URL" "$name"
  expect_code 1
  expect_output "$name"
  expect_no_calls
done

# Two merges can reach this job in either order. The older one arriving last
# must not roll production back, or migrate with an image older than the schema.
NEWER="fedcba9876543210fedcba9876543210fedcba98"
run_case "a commit that is no longer the head of main deploys nothing" ok "$DIGEST" "$SHA" "$NEWER"
expect_code 0
expect_output "no longer the head"
expect_no_calls

run_case "an unreadable head of main fails rather than skipping" ok "$DIGEST" "$SHA" ""
expect_code 1
expect_output "not a full commit SHA"
expect_no_calls

# --- verdict ----------------------------------------------------------------

echo
if [ "$failures" -gt 0 ]; then
  echo "${failures} assertion(s) failed" >&2
  exit 1
fi
echo "all tests passed"
