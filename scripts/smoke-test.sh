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
# Given a command after the image, the script runs it once the image has passed,
# while the container is still up, with SCHOOLGRID_ORIGIN set to where a browser
# reaches it and SCHOOLGRID_DATABASE_URL to its database as the application's
# login. The command failing fails the script. This is how the browser suite
# drives the image that ships, and why it needs no boot script of its own.
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
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-90}"
SMOKE_POLL_INTERVAL_SECONDS="${SMOKE_POLL_INTERVAL_SECONDS:-2}"

HEALTH_URL="http://127.0.0.1:${HOST_PORT}/api/health"

# `localhost` rather than the loopback address. Browsers keep a `Secure` cookie
# over plain http only on a host they treat as a secure context, and the image's
# PUBLIC_ORIGIN must be written exactly as a browser writes its `Origin`.
ORIGIN="http://localhost:${HOST_PORT}"

# Passed to the container only when set. The browser suite signs in, loads
# pages and calls the API from one address, which the default limit would
# throttle rather than test.
CONTAINER_RATE_LIMIT_MAX="${CONTAINER_RATE_LIMIT_MAX:-}"

workdir="$(mktemp -d)"
container=""

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
  if [ -z "$container" ]; then
    return
  fi
  echo
  echo "--- container logs (${IMAGE}) ---------------------------------------"
  docker logs "$container" 2>&1 || echo "(the logs could not be read)"
  echo "--- end of container logs ------------------------------------------"
}

# Runs on every exit, so a failure between `docker run` and the end of the
# script cannot leave a container holding the published port on the runner.
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    print_container_logs
  fi
  if [ -n "$container" ]; then
    docker rm --force "$container" >/dev/null 2>&1 || true
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

MIGRATIONS_TABLE_EXISTS="SELECT to_regclass('public.schema_migrations') IS NOT NULL"
APP_SCHEMA_EXISTS="SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'app')"
APPLIED_MIGRATIONS="SELECT count(*) FROM public.schema_migrations"

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

# Created and started as two steps rather than one `docker run`. When the runtime
# cannot exec the CMD at all, `run` fails without ever handing back the id of the
# container it created, so the logs could not be read and the container would
# never be removed. With the id held first, the cleanup trap covers that case too.
container="$(
  docker create \
    --add-host "${CONTAINER_POSTGRES_HOST}:host-gateway" \
    --publish "127.0.0.1:${HOST_PORT}:3000" \
    --env "DATABASE_URL=postgres://${APP_DB_USER}:${APP_DB_PASSWORD}@${CONTAINER_POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
    --env "MIGRATION_DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${CONTAINER_POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
    --env "PUBLIC_ORIGIN=${ORIGIN}" \
    ${CONTAINER_RATE_LIMIT_MAX:+--env "RATE_LIMIT_MAX=${CONTAINER_RATE_LIMIT_MAX}"} \
    "$IMAGE"
)"

if ! docker start "$container" >/dev/null; then
  fail "the container could not be started"
  exit 1
fi
pass "started ${IMAGE} as ${container}"

# --- poll /api/health -------------------------------------------------------

# A deadline rather than a number of attempts, so the bound is wall clock
# however long a single poll blocks. The job must fail on timeout rather than
# hang until the runner's own limit kills it with no diagnosis.
deadline=$(( $(date +%s) + SMOKE_TIMEOUT_SECONDS ))
healthy=false
status=""

while [ "$(date +%s)" -lt "$deadline" ]; do
  # Checked before the response, because a container that has exited will never
  # answer and waiting out the deadline for it buys nothing but a slower, vaguer
  # failure. This is what a broken entrypoint looks like from out here.
  if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo false)" != "true" ]; then
    fail "the container is no longer running"
    exit 1
  fi

  set +e
  status="$(
    curl --silent --show-error --max-time 5 \
      --output "$workdir/health.json" --write-out '%{http_code}' \
      "$HEALTH_URL" 2>/dev/null
  )"
  set -e

  # 200 alone is not the assertion. /api/health answers 503 with the same shape
  # when the database is unreachable, which is exactly what a bad connection
  # string or a missing `pg` in the runtime image produces, and a check reading
  # only the status code would call that a pass.
  if [ "$status" = "200" ] && grep -Eq '"database"[[:space:]]*:[[:space:]]*"reachable"' "$workdir/health.json"; then
    healthy=true
    break
  fi

  sleep "$SMOKE_POLL_INTERVAL_SECONDS"
done

if [ "$healthy" != true ]; then
  fail "/api/health did not become healthy within ${SMOKE_TIMEOUT_SECONDS}s (last status: ${status:-none})"
  if [ -s "$workdir/health.json" ]; then
    echo "  last body: $(cat "$workdir/health.json")" >&2
  fi
  exit 1
fi
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
#
# Read to a file first, never piped straight into `grep -q`. That grep exits at
# its first match and closes the pipe; if `docker logs` is still writing, it dies
# of SIGPIPE, and under `pipefail` the pipeline fails as though nothing matched.
# The migration line is one of the first a container logs, so the more it logs
# afterwards the likelier this check was to call a present line missing.
if ! docker logs "$container" > "$workdir/container.log" 2>&1; then
  fail "the container's logs could not be read"
  exit 1
fi
if ! grep -Eq '"msg"[[:space:]]*:[[:space:]]*"applied migrations"' "$workdir/container.log"; then
  fail "the container never reported applying migrations"
  echo "  The schema is present, but nothing in the container's log says it was" >&2
  echo "  the container that applied it." >&2
  exit 1
fi
pass "the container applied ${applied_count} migration(s) on startup"

# --- verdict ----------------------------------------------------------------

echo
echo "the smoke test passed: ${IMAGE} starts, migrates and reports the database reachable"

# --- a command against the passing image ------------------------------------

if [ "$#" -gt 0 ]; then
  echo
  if ! SCHOOLGRID_ORIGIN="$ORIGIN" \
    SCHOOLGRID_DATABASE_URL="postgres://${APP_DB_USER}:${APP_DB_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
    "$@"; then
    fail "the command run against the image failed: $*"
    exit 1
  fi
  pass "the command run against the image passed: $*"
fi
