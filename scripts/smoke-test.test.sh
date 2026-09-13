#!/usr/bin/env bash
#
# Tests for scripts/smoke-test.sh.
#
# The smoke test is the only check in the pipeline that starts the real
# process, so it is also the only check whose silent failure would leave a
# broken entrypoint undetected everywhere. Its failure modes are the usual
# ones for a polling script: a poll loop that reports success because `curl`
# was never really called, a timeout that never fires, a migration check that
# passes against a database someone else had already migrated.
#
# Neither Docker nor Postgres is needed here. `docker`, `curl` and `psql` are
# replaced by test doubles driven by a SCENARIO, so each case is a fabricated
# container and database and this runs anywhere bash does.
#
# Usage: scripts/smoke-test.test.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="${script_dir}/smoke-test.sh"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

failures=0

# --- the doubles ------------------------------------------------------------
#
# All three share a state directory. The docker double writes a marker when it
# starts the container and the psql double reads it, which is how the database
# becomes migrated only after something started the image — the causal order
# the real check depends on.

mkdir -p "$workdir/bin"

cat > "$workdir/bin/docker" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  run)
    echo started > "$STATE/started"
    if [ "$SCENARIO" = "broken-entrypoint" ]; then
      echo exited > "$STATE/exited"
    fi
    echo "double-container-id"
    ;;
  inspect)
    if [ -e "$STATE/exited" ]; then echo false; else echo true; fi
    ;;
  logs)
    if [ "$SCENARIO" = "broken-entrypoint" ]; then
      echo "exec /nodejs/bin/node: no such file or directory"
    else
      echo '{"level":30,"msg":"applied migrations","applied":["0001_initial.sql"]}'
      echo '{"level":30,"msg":"Server listening at http://0.0.0.0:3000"}'
    fi
    ;;
  rm) exit 0 ;;
  *) echo "double: unexpected docker $*" >&2; exit 64 ;;
esac
DOUBLE

# Answers the two queries the subject asks, and answers them differently
# before and after the container has been started.
cat > "$workdir/bin/psql" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
command=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[$i]}" = "--command" ]; then command="${args[$((i + 1))]}"; fi
done

if [ "$SCENARIO" = "database-down" ]; then
  echo "psql: error: connection refused" >&2
  exit 2
fi

migrated=false
if [ -e "$STATE/started" ] && [ "$SCENARIO" != "no-migrations" ]; then migrated=true; fi
if [ "$SCENARIO" = "dirty-database" ]; then migrated=true; fi

case "$command" in
  *count*)
    if [ "$migrated" = true ]; then echo 1; else echo 0; fi
    ;;
  *schema_migrations*)
    if [ "$migrated" = true ]; then echo t; else echo f; fi
    ;;
  *schemata*)
    if [ "$migrated" = true ]; then echo t; else echo f; fi
    ;;
  *) echo "double: unexpected query: ${command}" >&2; exit 64 ;;
esac
DOUBLE

cat > "$workdir/bin/curl" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
out=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[$i]}" = "--output" ]; then out="${args[$((i + 1))]}"; fi
done

refuse() {
  : > "$out"
  echo "000"
  exit 7
}

case "$SCENARIO" in
  broken-entrypoint|never-ready) refuse ;;
  unhealthy-database)
    echo '{"status":"unavailable","database":"unreachable"}' > "$out"
    echo "503"
    ;;
  *)
    echo '{"status":"ok","database":"reachable"}' > "$out"
    echo "200"
    ;;
esac
DOUBLE

chmod +x "$workdir/bin/docker" "$workdir/bin/psql" "$workdir/bin/curl"
export PATH="$workdir/bin:$PATH"

# --- the assertion ----------------------------------------------------------
#
# Asserts the exit code, and for a failing case that the output names the
# reason. A smoke test that fails for the wrong reason sends whoever reads the
# run looking in the wrong place.

expect() {
  local description="$1"
  local scenario="$2"
  local expected_code="$3"
  local expected_output="${4:-}"

  local state="$workdir/state/$description"
  mkdir -p "$state"

  local output
  local code=0
  output="$(
    SCENARIO="$scenario" \
    STATE="$state" \
    SMOKE_TIMEOUT_SECONDS=2 \
    SMOKE_POLL_INTERVAL_SECONDS=1 \
    bash "$subject" schoolgrid:test 2>&1
  )" || code=$?

  if [ "$code" -ne "$expected_code" ]; then
    echo "FAIL: ${description}" >&2
    echo "  expected exit ${expected_code}, got ${code}" >&2
    echo "$output" | sed 's/^/  | /' >&2
    failures=$((failures + 1))
    return
  fi

  if [ -n "$expected_output" ] && ! echo "$output" | grep -q "$expected_output"; then
    echo "FAIL: ${description}" >&2
    echo "  exit code was right but the output never said: ${expected_output}" >&2
    echo "$output" | sed 's/^/  | /' >&2
    failures=$((failures + 1))
    return
  fi

  echo "ok: ${description}"
}

# --- cases ------------------------------------------------------------------

expect "an image that boots and reaches the database passes" healthy 0 "the smoke test passed"

# The demonstration the ticket asks for, as a test rather than a one-off: an
# image whose entrypoint cannot execute.
expect "a broken entrypoint fails" broken-entrypoint 1 "the container is no longer running"
expect "a broken entrypoint surfaces the container logs" broken-entrypoint 1 "no such file or directory"

# A container that stays up but never serves a healthy response must end at the
# deadline. If this case hangs, the timeout is not wired up at all and this
# whole file stops terminating, which is its own loud failure.
expect "a container that never becomes healthy times out" never-ready 1 "did not become healthy within"
expect "a timeout surfaces the container logs" never-ready 1 "Server listening"

# 200 is not the assertion. The endpoint answers 503 with the same shape when
# the database is unreachable, which is precisely the case a missing production
# dependency or a bad connection string produces. It is polled rather than
# failed on sight, because a 503 while Postgres is still accepting its first
# connections is expected; what must not happen is a pass.
expect "a health check that reports the database unreachable never passes" unhealthy-database 1 "did not become healthy within"
expect "an unhealthy response is surfaced, not just counted" unhealthy-database 1 'last body: {"status":"unavailable"'

# The vacuous pass, and the reason the database is checked before the container
# starts as well as after: against an already-migrated database the post-check
# proves nothing about what the container did.
expect "an already-migrated database is caught before the container starts" dirty-database 1 "already carries the schema"

# The other half: the container came up healthy but left no migration behind,
# so whatever applied the schema, it was not this image on boot.
expect "a container that applied no migrations fails" no-migrations 1 "applied no migrations"

# If the database cannot be reached at all, that is the harness being broken
# rather than the image, and it has to say so instead of reporting a clean run.
expect "an unreachable database fails before anything is started" database-down 1 "could not query the database"

# --- verdict ----------------------------------------------------------------

echo
if [ "$failures" -gt 0 ]; then
  echo "${failures} test(s) failed" >&2
  exit 1
fi
echo "all tests passed"
