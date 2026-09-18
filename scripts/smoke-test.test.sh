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
last="${*: -1}"

# The subject starts the image more than once, with and without the schema
# owner's credentials, and each container behaves as the image would given what
# it was handed. A container given MIGRATION_DATABASE_URL migrates; one without
# it checks the record the psql double keeps, and refuses to start when a
# migration has gone missing from it.
owner() { [ -e "$STATE/$1.owner" ]; }
exited() { [ -e "$STATE/$1.exited" ]; }

case "$1" in
  create)
    count=$(( $(cat "$STATE/created" 2>/dev/null || echo 0) + 1 ))
    echo "$count" > "$STATE/created"
    id="double-container-${count}"
    for arg in "$@"; do
      case "$arg" in MIGRATION_DATABASE_URL=*) touch "$STATE/${id}.owner" ;; esac
    done
    echo "$id"
    ;;
  start)
    # What Docker does when the runtime cannot exec the CMD at all: the
    # container exists, but `start` fails and nothing ever runs in it.
    if [ "$SCENARIO" = "unstartable" ]; then
      echo 'Error response from daemon: failed to create task: exec: "dist/index.js": no such file or directory' >&2
      exit 125
    fi
    if owner "$last"; then
      echo started > "$STATE/started"
      if [ "$SCENARIO" = "broken-entrypoint" ]; then touch "$STATE/${last}.exited"; fi
    elif [ -e "$STATE/record-deleted" ]; then
      if [ "$SCENARIO" != "ownerless-serves-unmigrated" ]; then touch "$STATE/${last}.exited"; fi
    elif [ "$SCENARIO" = "ownerless-refuses-migrated" ]; then
      touch "$STATE/${last}.exited"
    fi
    echo "$last"
    ;;
  inspect)
    case "$*" in
      *Running*) if exited "$last"; then echo false; else echo true; fi ;;
      *ExitCode*)
        if exited "$last" && [ "$SCENARIO" != "ownerless-exits-zero" ]; then echo 1; else echo 0; fi
        ;;
      *) echo "double: unexpected docker $*" >&2; exit 64 ;;
    esac
    ;;
  logs)
    if ! owner "$last"; then
      if exited "$last"; then
        if [ "$SCENARIO" = "ownerless-silent-refusal" ]; then
          echo '{"level":60,"msg":"failed to start"}'
        else
          echo "{\"level\":60,\"err\":{\"message\":\"The database is missing migration(s) $(cat "$STATE/record-deleted" 2>/dev/null)\"},\"msg\":\"failed to start\"}"
        fi
      else
        if [ "$SCENARIO" = "ownerless-migrates" ]; then
          echo '{"level":30,"msg":"applied migrations","applied":["0001_initial.sql"]}'
        else
          echo '{"level":30,"msg":"not migrating without MIGRATION_DATABASE_URL: every migration is already applied"}'
        fi
        echo '{"level":30,"msg":"Server listening at http://0.0.0.0:3000"}'
      fi
    elif [ "$SCENARIO" = "broken-entrypoint" ]; then
      echo "exec /nodejs/bin/node: no such file or directory"
    elif [ "$SCENARIO" = "silent-migration" ]; then
      echo '{"level":30,"msg":"Server listening at http://0.0.0.0:3000"}'
    elif [ "$SCENARIO" = "chatty-container" ]; then
      # The migration line first, then far more log than a pipe buffer holds.
      # A reader that stops at the first match closes the pipe while this is
      # still writing, and the write fails with SIGPIPE, as `docker logs` does
      # for a container that has logged a lot since it migrated.
      echo '{"level":30,"msg":"applied migrations","applied":["0001_initial.sql"]}'
      line='{"level":30,"msg":"incoming request","req":{"method":"GET","url":"/api/health"}}'
      for _ in $(seq 1 20000); do echo "$line"; done
    else
      echo '{"level":30,"msg":"applied migrations","applied":["0001_initial.sql"]}'
      echo '{"level":30,"msg":"Server listening at http://0.0.0.0:3000"}'
    fi
    ;;
  rm)
    echo removed > "$STATE/removed"
    touch "$STATE/${last}.removed"
    ;;
  *) echo "double: unexpected docker $*" >&2; exit 64 ;;
esac
DOUBLE

# Answers the queries the subject asks, and answers them differently before and
# after the container has been started.
cat > "$workdir/bin/psql" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
command=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[$i]}" = "--command" ]; then command="${args[$((i + 1))]}"; fi
done

if [ "$SCENARIO" = "database-down" ] || { [ "$SCENARIO" = "database-lost" ] && [ -e "$STATE/started" ]; }; then
  echo "psql: error: connection refused" >&2
  exit 2
fi

migrated=false
if [ -e "$STATE/started" ] && [ "$SCENARIO" != "no-migrations" ]; then migrated=true; fi
if [ "$SCENARIO" = "dirty-database" ]; then migrated=true; fi

case "$command" in
  *"CREATE ROLE"*)
    ;;
  # Taking the latest migration out of the record, and putting it back.
  *DELETE*schema_migrations*)
    if [ "$SCENARIO" = "empty-record" ]; then exit 0; fi
    echo "0011_migration_record_readable.sql" > "$STATE/record-deleted"
    echo "0011_migration_record_readable.sql|0123abcd"
    ;;
  *INSERT*schema_migrations*)
    case "$command" in
      *"'0011_migration_record_readable.sql', '0123abcd'"*) ;;
      *) echo "double: restored something else: ${command}" >&2; exit 64 ;;
    esac
    rm -f "$STATE/record-deleted"
    touch "$STATE/record-restored"
    ;;
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
url=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[$i]}" = "--output" ]; then out="${args[$((i + 1))]}"; fi
  case "${args[$i]}" in http://*) url="${args[$i]}" ;; esac
done

# The API is served under /api, and anywhere else the service refuses as the
# real one does, so a subject polling the wrong path never sees a healthy answer.
if [ "${url%/api/health}" = "$url" ]; then
  echo '{"status":"refused"}' > "$out"
  echo "404"
  exit 0
fi

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
  # A second reason printed alongside the right one is still the wrong reason,
  # so a case can also name what the output must never say.
  local forbidden_output="${5:-}"

  local state="$workdir/state/$description"
  mkdir -p "$state"

  local output
  local code=0
  output="$(
    SCENARIO="$scenario" \
    STATE="$state" \
    SMOKE_TIMEOUT_SECONDS=2 \
    SMOKE_POLL_INTERVAL_SECONDS=1 \
    bash "$subject" schoolgrid:test ${then_command[@]+"${then_command[@]}"} 2>&1
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

  if [ -n "$forbidden_output" ] && echo "$output" | grep -q "$forbidden_output"; then
    echo "FAIL: ${description}" >&2
    echo "  the output also said: ${forbidden_output}" >&2
    echo "$output" | sed 's/^/  | /' >&2
    failures=$((failures + 1))
    return
  fi

  echo "ok: ${description}"
}

# Asserts that the container a case created was removed on the way out, so a
# failed run cannot leave it holding the published port on the runner.
expect_removed() {
  local description="$1"
  if [ -e "$workdir/state/$description/removed" ]; then
    echo "ok: ${description} (container removed)"
  else
    echo "FAIL: ${description}" >&2
    echo "  the container was never removed" >&2
    failures=$((failures + 1))
  fi
}

# Asserts that a case put back the migration record it took out, so the browser
# suite run afterwards meets the database the image migrated.
expect_restored() {
  local description="$1"
  local state="$workdir/state/$description"
  if [ -e "$state/record-restored" ] && [ ! -e "$state/record-deleted" ]; then
    echo "ok: ${description} (migration record restored)"
  else
    echo "FAIL: ${description}" >&2
    echo "  the migration taken out of the record was never put back" >&2
    failures=$((failures + 1))
  fi
}

# --- cases ------------------------------------------------------------------

# A command to run against the image once it has passed, as the browser suite
# is run. Empty unless a case sets it.
then_command=()

expect "an image that boots and reaches the database passes" healthy 0 "the smoke test passed"

# An image whose entrypoint starts and dies. This pins the behaviour down; it
# does not replace the ticket's demonstration against a real broken image, which
# is recorded on #17 from an actual run.
expect "a broken entrypoint fails" broken-entrypoint 1 "the container is no longer running"
expect "a broken entrypoint surfaces the container logs" broken-entrypoint 1 "no such file or directory"

# The other way an entrypoint breaks: the runtime cannot exec the CMD, so the
# container is created but never starts. Docker's error is the whole diagnosis,
# and the created container must still be cleaned up.
expect "an entrypoint that cannot be executed fails" unstartable 1 'exec: "dist/index.js"'
expect_removed "an entrypoint that cannot be executed fails"

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

# The third leg. The database checks say a schema appeared after the container
# started; the container's own log line says the container is what put it
# there, rather than anything else that reached the same database meanwhile.
expect "a container that never reports applying migrations fails" silent-migration 1 "never reported applying migrations"

# The same check against a container that logged a great deal after migrating.
# Under `pipefail`, a reader that exits at its first match turns the writer's
# SIGPIPE into a failed pipeline, and the check would report a migration that
# the log plainly contains as missing. Seen intermittently in CI on #49.
expect "a container that logged a lot after migrating still passes" chatty-container 0 "the smoke test passed" "never reported applying migrations"

# Without the schema owner's credentials, as production runs it, the image must
# serve a database that is already migrated, and say it did not migrate it.
expect "without owner credentials the image serves a migrated database" healthy 0 \
  "serves a migrated database without migrating it"
expect "an image that will not serve a migrated database without owner credentials fails" \
  ownerless-refuses-migrated 1 "started without MIGRATION_DATABASE_URL is no longer running"
expect "an image that migrates without owner credentials fails" ownerless-migrates 1 \
  "never reported starting without migrating"

# And it must refuse a database missing a migration: exit non-zero, and name
# what is missing, since that line is all a failed deploy has to go on.
expect "without owner credentials the image refuses a database missing a migration" healthy 0 \
  "refused a database missing 0011_migration_record_readable.sql"
expect_restored "without owner credentials the image refuses a database missing a migration"
expect "an image that serves a database missing a migration fails" ownerless-serves-unmigrated 1 \
  "kept running against a database missing 0011_migration_record_readable.sql"
# A failing case must not leave the record short: the run is over, but the
# header promises the database comes back as the image left it.
expect_restored "an image that serves a database missing a migration fails"
expect "an image that refuses but exits zero fails" ownerless-exits-zero 1 "exited 0"
expect "an image that refuses without saying why fails" ownerless-silent-refusal 1 \
  "never named 0011_migration_record_readable.sql"

# With nothing taken out of the record, every check after it would pass against
# a database missing nothing, and a grep for an empty name matches any log.
expect "a record with nothing to take out fails rather than passing vacuously" empty-record 1 \
  "took no migration out of the record"

# If the database cannot be reached at all, that is the harness being broken
# rather than the image, and it has to say so instead of reporting a clean run.
expect "an unreachable database fails before anything is started" database-down 1 "could not query the database" "already carries the schema"

# The same after boot: a database lost mid-run is the harness failing, and must
# not be reported as an image that applied nothing.
expect "a database lost after boot is reported as itself" database-lost 1 "could not query the database" "applied no migrations"

# A command given after the image runs against the image the smoke test passed,
# while it is still up, and is told where to reach it and its database.
then_command=(bash -c 'echo "then saw ${SCHOOLGRID_ORIGIN} and ${SCHOOLGRID_DATABASE_URL}"')
expect "a command given after the image runs against the passing image" healthy 0 \
  "then saw http://localhost:3000 and postgres://schoolgrid_runtime:schoolgrid_runtime@127.0.0.1:5432/schoolgrid"
expect_removed "a command given after the image runs against the passing image"

# The browser suite failing must fail the job, not print and pass.
then_command=(false)
expect "a failing command fails the smoke test" healthy 1 "the command run against the image failed"
expect "a failing command surfaces the container logs" healthy 1 "Server listening"

# Nothing is run against an image that did not pass: its failure would only
# bury the real one.
then_command=(bash -c 'echo "then ran"')
expect "no command is run against an image that never becomes healthy" never-ready 1 \
  "did not become healthy within" "then ran"
then_command=()

# --- verdict ----------------------------------------------------------------

echo
if [ "$failures" -gt 0 ]; then
  echo "${failures} test(s) failed" >&2
  exit 1
fi
echo "all tests passed"
