#!/usr/bin/env bash
#
# Start the built runtime image against a real Postgres and require it to
# answer /api/health with the database reachable.
#
# This is the only check in the pipeline that runs the real process. The test
# suite drives the application through Fastify's `inject`, which never binds a
# socket and never executes the entrypoint, and every scanner inspects a
# filesystem without running anything. So a broken CMD, a production dependency
# left in devDependencies, or a migration that fails on boot passes everything
# else and surfaces on a real deployment.
#
# Nothing here migrates the database. The image is expected to do that itself on
# startup, and the proof is the ordering: the database is asserted empty before
# the container starts and migrated afterwards, with the container's own log
# line as the third leg. A migrate step anywhere in this script or its job would
# turn that proof into a tautology.
#
# Then the image is started twice more without MIGRATION_DATABASE_URL, as
# production runs it: once against the database it just migrated, where it must
# serve without migrating, and once with the latest migration taken out of the
# record, where it must exit non-zero and name that migration. The record is put
# back afterwards, so anything run below meets the database as the image left it.
#
# Given a command after the image, the script runs it once the image has passed,
# while the container is still up, with SCHOOLGRID_ORIGIN set to where a browser
# reaches it and SCHOOLGRID_DATABASE_URL to its database as the application's
# login. The command failing fails the script. This is how the browser suite
# drives the image that ships, and why it needs no boot script of its own.
#
# Before that command, the database gets the public demo's seed, demo/seed.sql,
# and the image is started once more as the demo runs it: without the owner's
# credentials and with DEMO_MODE on. SCHOOLGRID_DEMO_ORIGIN tells the command
# where. The first container keeps DEMO_MODE off, as every other deployment does.
#
# On the way out, pass or fail, it prints the most /api requests each of those
# two containers was sent in any one minute, against the rate limit it ran with.
#
# Usage: scripts/smoke-test.sh <image-ref> [command...]

set -euo pipefail

IMAGE="${1:?usage: smoke-test.sh <image-ref> [command...]}"
shift

# Where this script reaches Postgres. On a GitHub runner a service container
# publishes to the host, so the default is the loopback address.
POSTGRES_HOST="${POSTGRES_HOST:-127.0.0.1}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-schoolgrid}"

# The login the application serves requests as. POSTGRES_USER above owns the
# schema and is handed to the container for migrating only; see
# docs/database-roles.md.
APP_DB_USER="${APP_DB_USER:-schoolgrid_runtime}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-schoolgrid_runtime}"

# Where the *container* reaches the same Postgres, which is not the same
# address: inside the container, loopback is the container. The name is mapped
# to `host-gateway` below.
CONTAINER_POSTGRES_HOST="${CONTAINER_POSTGRES_HOST:-host.docker.internal}"

HOST_PORT="${HOST_PORT:-3000}"
# For the containers started without the owner's credentials, two of which
# serve alongside the first: one checked above, and the demo.
OWNERLESS_HOST_PORT="${OWNERLESS_HOST_PORT:-3001}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-90}"
SMOKE_POLL_INTERVAL_SECONDS="${SMOKE_POLL_INTERVAL_SECONDS:-2}"
# The rate limit every container here runs with: see `start_image` for why it
# is wider than production's, and `report_headroom` for how close it came.
RATE_LIMIT_MAX="${SMOKE_RATE_LIMIT_MAX:-1000}"

# `localhost` rather than the loopback address. Browsers keep a `Secure` cookie
# over plain http only on a host they treat as a secure context, and the image's
# PUBLIC_ORIGIN must be written exactly as a browser writes its `Origin`. This is
# where the browser suite reaches the first container, and `start_image` builds
# that container's PUBLIC_ORIGIN the same way from its port.
ORIGIN="http://localhost:${HOST_PORT}"
DEMO_ORIGIN="http://localhost:${OWNERLESS_HOST_PORT}"

# The public demo's seed. It is in the repository and never in the image.
DEMO_SEED="${DEMO_SEED:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/demo/seed.sql}"

workdir="$(mktemp -d)"
# Every container this script has created and not yet removed.
containers=()
# A row taken out of the migration record and not yet put back, as
# `name|checksum`. Put back on the way out, however the script ends.
taken_from_record=""

# --- reporting --------------------------------------------------------------

fail() {
  echo "FAIL: $*" >&2
}

pass() {
  echo "ok: $*"
}

# The logs are the whole diagnosis for the failures this catches: a container
# that exits immediately says why in its last line, and a migration that fails
# on boot says which migration. Printing them on the way out means a failure is
# readable from the run alone, without a rerun and without an interactive shell
# the image deliberately does not have.
print_container_logs() {
  local id
  for id in ${containers[@]+"${containers[@]}"}; do
    echo
    echo "--- container logs (${IMAGE}, ${id}) ---------------------------------"
    docker logs "$id" 2>&1 || echo "(the logs could not be read)"
    echo "--- end of container logs ------------------------------------------"
  done
}

# Prints the most /api requests container $1 was sent in any one rate-limit
# window, against the limit it ran with, and warns once that passes 80%. $2
# names the container.
#
# The browser suite's requests all reach a container from one address, so the
# limit sees the whole suite as one client. A 429 already fails the suite (the
# `throttled` fixture in e2e/test.ts); this is the warning before that, while
# raising SMOKE_RATE_LIMIT_MAX is still a choice rather than a fix. It never
# fails the run itself.
#
# Counted from Fastify's own "incoming request" lines, whose `time` is epoch
# milliseconds. A sliding window, so the peak is at least what any of the
# limiter's fixed windows saw. The window is production's (DEFAULT_RATE_LIMIT
# in src/config.ts), which nothing here overrides.
report_headroom() {
  local id="$1"
  local name="$2"
  local log="$workdir/headroom-${id}.log"
  docker logs "$id" > "$log" 2>&1 || return 1

  local peak
  peak="$(
    { grep -E '"msg"[[:space:]]*:[[:space:]]*"incoming request"' "$log" || true; } \
      | { grep -E '"url"[[:space:]]*:[[:space:]]*"/api([/?"])' || true; } \
      | sed -nE 's/.*"time"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' \
      | sort -n \
      | awk -v window=60000 '
          { at[NR] = $1; while (at[NR] - at[first + 1] >= window) first++; if (NR - first > peak) peak = NR - first }
          END { print peak + 0 }
        '
  )" || return 1

  echo "rate limit: ${name} was sent at most ${peak} /api requests in any 60s window, of RATE_LIMIT_MAX ${RATE_LIMIT_MAX}"
  if [ $(( peak * 100 )) -gt $(( RATE_LIMIT_MAX * 80 )) ]; then
    echo "warning: that is above 80% of the limit. Raise SMOKE_RATE_LIMIT_MAX before the browser suite is throttled." >&2
  fi
}

# Runs on every exit, so a failure between `docker create` and the end of the
# script cannot leave a container holding a published port on the runner.
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    print_container_logs
  fi
  # Pass or fail: headroom that is running out shows before it fails a run.
  # Called with `||`, so a failure inside cannot end the cleanup early.
  if [ -n "${container:-}" ]; then
    echo
    report_headroom "$container" "the container at ${ORIGIN}" || echo "(the rate limit headroom at ${ORIGIN} could not be measured)" >&2
  fi
  if [ -n "${demo:-}" ]; then
    report_headroom "$demo" "the demo at ${DEMO_ORIGIN}" || echo "(the rate limit headroom at ${DEMO_ORIGIN} could not be measured)" >&2
  fi
  local id
  for id in ${containers[@]+"${containers[@]}"}; do
    docker rm --force "$id" >/dev/null 2>&1 || true
  done
  if [ -n "$taken_from_record" ]; then
    restore_record || echo "(the migration record could not be restored)" >&2
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

# --- the database -----------------------------------------------------------

# Runs one query and stores its single value in the variable named by $1.
#
# Not a function to call inside `$(...)`. A query that cannot run is this harness
# being broken rather than the image being bad, and it has to end the script as
# that. From inside a command substitution `exit` leaves only the subshell, and
# the check around it goes on to read the empty result as a verdict about the
# image. Assigning through a name keeps the exit in the script itself.
query() {
  local into="$1"
  local sql="$2"
  local output

  # stderr is kept out of the value. A notice on it would otherwise turn a `t`
  # into something no comparison below recognises.
  if ! output="$(
    PGPASSWORD="$POSTGRES_PASSWORD" psql \
      --no-psqlrc --quiet --tuples-only --no-align \
      --host "$POSTGRES_HOST" --port "$POSTGRES_PORT" \
      --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
      --command "$sql" 2>"$workdir/psql.err"
  )"; then
    fail "could not query the database at ${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
    cat "$workdir/psql.err" >&2
    exit 1
  fi

  printf -v "$into" '%s' "$(echo "$output" | tr -d '[:space:]')"
}

# Puts back the row taken out of the migration record. Called directly rather
# than through `query`, whose failure exits: from inside the cleanup trap that
# would skip the rest of the cleanup.
restore_record() {
  local name="${taken_from_record%%|*}"
  local checksum="${taken_from_record#*|}"
  PGPASSWORD="$POSTGRES_PASSWORD" psql \
    --no-psqlrc --quiet --tuples-only --no-align \
    --host "$POSTGRES_HOST" --port "$POSTGRES_PORT" \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --command "INSERT INTO public.schema_migrations (name, checksum) VALUES ('${name}', '${checksum}')" \
    >/dev/null 2>"$workdir/psql.err" || return 1
  taken_from_record=""
}

MIGRATIONS_TABLE_EXISTS="SELECT to_regclass('public.schema_migrations') IS NOT NULL"
APP_SCHEMA_EXISTS="SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'app')"
APPLIED_MIGRATIONS="SELECT count(*) FROM public.schema_migrations"

# --- the image --------------------------------------------------------------

# Creates and starts the image, storing the container's id in the variable named
# by $1 and publishing it on host port $2. Given `with-owner` as $3, it is also
# handed the schema owner's connection, and migrates; otherwise it holds only
# the application's role, as production does. Given `demo`, it holds only that
# role and runs with DEMO_MODE on, as the public demo does.
#
# Created and started as two steps rather than one `docker run`. When the runtime
# cannot exec the CMD at all, `run` fails without ever handing back the id of the
# container it created, so the logs could not be read and the container would
# never be removed. With the id held first, the cleanup trap covers that case too.
#
# RATE_LIMIT_MAX is raised well past the production default (see
# DEFAULT_RATE_LIMIT in src/config.ts). Every request the browser suite makes
# below shares this one container's IP as far as the rate limiter can tell, so
# the production limit — sized for one real client — throttles the whole suite
# partway through, not the abuse it is meant to catch. Widened rather than the
# suite paced: pacing would slow every run to protect a limit this container
# does not need, and would still break as specs are added. Whether the width
# is enough is checked on every run, not assumed: e2e/test.ts fails any test
# that had a request throttled, and says to raise this, and `report_headroom`
# prints how close each run came.
start_image() {
  local into="$1"
  local port="$2"
  local mode="${3:-}"
  local args=(
    --add-host "${CONTAINER_POSTGRES_HOST}:host-gateway"
    --publish "127.0.0.1:${port}:3000"
    --env "DATABASE_URL=postgres://${APP_DB_USER}:${APP_DB_PASSWORD}@${CONTAINER_POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
    --env "PUBLIC_ORIGIN=http://localhost:${port}"
    --env "RATE_LIMIT_MAX=${RATE_LIMIT_MAX}"
  )
  if [ "$mode" = "with-owner" ]; then
    args+=(--env "MIGRATION_DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${CONTAINER_POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}")
  elif [ "$mode" = "demo" ]; then
    args+=(--env "DEMO_MODE=true")
  fi

  local id
  id="$(docker create "${args[@]}" "$IMAGE")"
  containers+=("$id")
  printf -v "$into" '%s' "$id"

  if ! docker start "$id" >/dev/null; then
    fail "the container could not be started"
    exit 1
  fi
}

# Removes a container this script is done with, freeing its port.
remove_container() {
  local id="$1"
  local kept=()
  local other
  docker rm --force "$id" >/dev/null 2>&1 || true
  for other in ${containers[@]+"${containers[@]}"}; do
    if [ "$other" != "$id" ]; then kept+=("$other"); fi
  done
  containers=(${kept[@]+"${kept[@]}"})
}

running() {
  [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

# Polls container $1, published on host port $2, until /api/health reports the
# database reachable, and ends the script if it never does. $3 names the
# container in a failure.
#
# A deadline rather than a number of attempts, so the bound is wall clock
# however long a single poll blocks. The job must fail on timeout rather than
# hang until the runner's own limit kills it with no diagnosis.
await_healthy() {
  local id="$1"
  local url="http://127.0.0.1:$2/api/health"
  local name="$3"
  local deadline=$(( $(date +%s) + SMOKE_TIMEOUT_SECONDS ))
  local status=""

  while [ "$(date +%s)" -lt "$deadline" ]; do
    # Checked before the response, because a container that has exited will
    # never answer and waiting out the deadline for it buys nothing but a
    # slower, vaguer failure. This is what a broken entrypoint looks like from
    # out here.
    if ! running "$id"; then
      fail "${name} is no longer running"
      exit 1
    fi

    set +e
    status="$(
      curl --silent --show-error --max-time 5 \
        --output "$workdir/health.json" --write-out '%{http_code}' \
        "$url" 2>/dev/null
    )"
    set -e

    # 200 alone is not the assertion. /api/health answers 503 with the same
    # shape when the database is unreachable, which is exactly what a bad
    # connection string or a missing `pg` in the runtime image produces, and a
    # check reading only the status code would call that a pass.
    if [ "$status" = "200" ] && grep -Eq '"database"[[:space:]]*:[[:space:]]*"reachable"' "$workdir/health.json"; then
      return
    fi

    sleep "$SMOKE_POLL_INTERVAL_SECONDS"
  done

  fail "/api/health did not become healthy within ${SMOKE_TIMEOUT_SECONDS}s (last status: ${status:-none})"
  if [ -s "$workdir/health.json" ]; then
    echo "  last body: $(cat "$workdir/health.json")" >&2
  fi
  exit 1
}

# Waits, up to the same deadline, for container $1 to stop; succeeds only if it did.
await_exited() {
  local deadline=$(( $(date +%s) + SMOKE_TIMEOUT_SECONDS ))
  while running "$1" && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep "$SMOKE_POLL_INTERVAL_SECONDS"
  done
  ! running "$1"
}

# Reads the logs of container $1 into the file $2.
#
# Read to a file first, never piped straight into `grep -q`. That grep exits at
# its first match and closes the pipe; if `docker logs` is still writing, it dies
# of SIGPIPE, and under `pipefail` the pipeline fails as though nothing matched.
# The migration line is one of the first a container logs, so the more it logs
# afterwards the likelier a check was to call a present line missing.
read_logs() {
  if ! docker logs "$1" > "$2" 2>&1; then
    fail "the container's logs could not be read"
    exit 1
  fi
}

# --- the database must start empty ------------------------------------------
#
# Otherwise the check that the container migrated on boot proves nothing: an
# already-migrated database reports exactly the same thing whether the image
# applied anything or not.

query migrations_table "$MIGRATIONS_TABLE_EXISTS"
query app_schema "$APP_SCHEMA_EXISTS"
if [ "$migrations_table" != "f" ] || [ "$app_schema" != "f" ]; then
  fail "the database already carries the schema before the container has started"
  echo "  Nothing here migrates it, so something else did, and the migration" >&2
  echo "  check below would pass whatever the image does on boot." >&2
  exit 1
fi
pass "the database is empty, so anything found later was applied by the container"

# --- the application's role -------------------------------------------------
#
# Arranged the way a deployment arranges it, before the image starts. Roles
# belong to the cluster rather than to the database, so this leaves the schema
# as empty as the check above found it. The image refuses to start if the role
# it serves as could alter Audit records, so a pass also proves the two
# connections really are separate.

PROVISION_APP_ROLE="DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'schoolgrid_app') THEN
    CREATE ROLE schoolgrid_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
    CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}' IN ROLE schoolgrid_app;
  END IF;
END
\$\$"
query _provisioned "$PROVISION_APP_ROLE"
pass "the application's login ${APP_DB_USER} exists, holding only schoolgrid_app"

# --- start the image --------------------------------------------------------

start_image container "$HOST_PORT" with-owner
pass "started ${IMAGE} as ${container}"

await_healthy "$container" "$HOST_PORT" "the container"
pass "/api/health answered 200 with the database reachable"

# --- the container migrated on boot -----------------------------------------

query migrations_table "$MIGRATIONS_TABLE_EXISTS"
applied_count=0
if [ "$migrations_table" = "t" ]; then
  query applied_count "$APPLIED_MIGRATIONS"
fi
if [ "$migrations_table" != "t" ] || [ "$applied_count" = "0" ]; then
  fail "the container came up healthy but applied no migrations"
  echo "  The database was empty before it started, so the schema it is serving" >&2
  echo "  against is not one it created." >&2
  exit 1
fi

query app_schema "$APP_SCHEMA_EXISTS"
if [ "$app_schema" != "t" ]; then
  fail "the app schema is absent, so the migrations that ran are not this repository's"
  exit 1
fi

# The third leg. The database says a schema appeared after the container started;
# only the container's own log says the container is what applied it. `app.log`
# is pino, so the line is JSON and the message is matched as a field.
read_logs "$container" "$workdir/container.log"
if ! grep -Eq '"msg"[[:space:]]*:[[:space:]]*"applied migrations"' "$workdir/container.log"; then
  fail "the container never reported applying migrations"
  echo "  The schema is present, but nothing in the container's log says it was" >&2
  echo "  the container that applied it." >&2
  exit 1
fi
pass "the container applied ${applied_count} migration(s) on startup"

# --- without the owner's credentials: a migrated database -------------------
#
# How production runs the image: holding the application's role alone, against
# a database migrated before it started. It must serve, and must say it did not
# migrate: an image with an owner connection string baked in would pass the
# health check just the same.

start_image ownerless "$OWNERLESS_HOST_PORT"
await_healthy "$ownerless" "$OWNERLESS_HOST_PORT" "the container started without MIGRATION_DATABASE_URL"
read_logs "$ownerless" "$workdir/ownerless.log"
if ! grep -Eq '"msg"[[:space:]]*:[[:space:]]*"not migrating without MIGRATION_DATABASE_URL' "$workdir/ownerless.log"; then
  fail "the container started without MIGRATION_DATABASE_URL never reported starting without migrating"
  exit 1
fi
remove_container "$ownerless"
pass "without MIGRATION_DATABASE_URL, ${IMAGE} serves a migrated database without migrating it"

# --- without the owner's credentials: a missing migration -------------------
#
# The latest migration is taken out of the record, which is all the image reads
# to decide. The schema itself is left alone, so the first container keeps
# serving, and the record is put back once the image has refused.

query taken_from_record "WITH taken AS (
  DELETE FROM public.schema_migrations
  WHERE name = (SELECT max(name) FROM public.schema_migrations)
  RETURNING name, checksum
) SELECT name || '|' || checksum FROM taken"
# Without a row, every check below would pass against a database missing
# nothing, and a search of the log for an empty name matches anything.
if [[ "$taken_from_record" != ?*"|"?* ]]; then
  fail "took no migration out of the record, so there is nothing for the image to refuse"
  taken_from_record=""
  exit 1
fi
missing="${taken_from_record%%|*}"

start_image refusing "$OWNERLESS_HOST_PORT"

if ! await_exited "$refusing"; then
  fail "the container started without MIGRATION_DATABASE_URL kept running against a database missing ${missing}"
  exit 1
fi

exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$refusing")"
if [ "$exit_code" = "0" ]; then
  fail "the container started against a database missing ${missing} stopped, but exited 0"
  exit 1
fi

# Its log is all a failed deploy has to go on, so it must say what failed.
read_logs "$refusing" "$workdir/refusing.log"
if ! grep -qF "$missing" "$workdir/refusing.log"; then
  fail "the container that refused to start never named ${missing}, the migration it was missing"
  exit 1
fi

if ! restore_record; then
  fail "could not put ${missing} back into the migration record"
  cat "$workdir/psql.err" >&2
  exit 1
fi
remove_container "$refusing"
pass "without MIGRATION_DATABASE_URL, ${IMAGE} refused a database missing ${missing}, exiting ${exit_code}"

# --- verdict ----------------------------------------------------------------

echo
echo "the smoke test passed: ${IMAGE} starts, migrates and reports the database reachable," \
  "and without the owner's credentials serves a fully migrated database only"

# --- a command against the passing image ------------------------------------

if [ "$#" -gt 0 ]; then
  echo

  # As the maintainer seeds the demo: as the schema owner, stopping at the
  # first error, into the database the image has migrated.
  if ! PGPASSWORD="$POSTGRES_PASSWORD" psql \
    --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
    --host "$POSTGRES_HOST" --port "$POSTGRES_PORT" \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --file "$DEMO_SEED" >/dev/null 2>"$workdir/psql.err"; then
    fail "could not seed the demo from ${DEMO_SEED}"
    cat "$workdir/psql.err" >&2
    exit 1
  fi
  pass "seeded the demo from ${DEMO_SEED}"

  start_image demo "$OWNERLESS_HOST_PORT" demo
  await_healthy "$demo" "$OWNERLESS_HOST_PORT" "the container started with DEMO_MODE on"
  pass "with DEMO_MODE on, ${IMAGE} serves the demo at ${DEMO_ORIGIN}"

  if ! SCHOOLGRID_ORIGIN="$ORIGIN" \
    SCHOOLGRID_DEMO_ORIGIN="$DEMO_ORIGIN" \
    SCHOOLGRID_DATABASE_URL="postgres://${APP_DB_USER}:${APP_DB_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
    "$@"; then
    fail "the command run against the image failed: $*"
    exit 1
  fi
  pass "the command run against the image passed: $*"
fi
