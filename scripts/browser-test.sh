#!/usr/bin/env bash
#
# Start the built runtime image against a real Postgres and run the browser
# suite against it.
#
# The HTTP suite proves the domain through Fastify's `inject`, and the smoke
# test proves the image boots. Neither runs a browser, so neither can show that
# the cookie, the Content Security Policy and same-origin serving work together
# in the image that ships. This is the only check that does.
#
# Unlike the smoke test, this does not need the database empty: the image
# migrates on boot either way, and the suite arranges its own fixtures under
# names of its own.
#
# Usage: scripts/browser-test.sh <image-ref>

set -euo pipefail

IMAGE="${1:?usage: browser-test.sh <image-ref>}"

POSTGRES_HOST="${POSTGRES_HOST:-127.0.0.1}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-schoolgrid}"
APP_DB_USER="${APP_DB_USER:-schoolgrid_runtime}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-schoolgrid_runtime}"
CONTAINER_POSTGRES_HOST="${CONTAINER_POSTGRES_HOST:-host.docker.internal}"
HOST_PORT="${HOST_PORT:-3000}"
BOOT_TIMEOUT_SECONDS="${BOOT_TIMEOUT_SECONDS:-90}"

# `localhost`, not 127.0.0.1. Browsers keep a `Secure` cookie over plain http
# only on a host they treat as a secure context, and the public origin must be
# written exactly as the browser writes its `Origin`.
ORIGIN="http://localhost:${HOST_PORT}"

container=""

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ] && [ -n "$container" ]; then
    echo
    echo "--- container logs (${IMAGE}) ---------------------------------------"
    docker logs "$container" 2>&1 || echo "(the logs could not be read)"
    echo "--- end of container logs ------------------------------------------"
  fi
  if [ -n "$container" ]; then
    docker rm --force "$container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# The application's login, arranged as a deployment arranges it. Idempotent, so
# it does not matter whether the smoke test has already run against this cluster.
PGPASSWORD="$POSTGRES_PASSWORD" psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  --host "$POSTGRES_HOST" --port "$POSTGRES_PORT" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'schoolgrid_app') THEN
    CREATE ROLE schoolgrid_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
    CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}' IN ROLE schoolgrid_app;
  END IF;
END
\$\$;
SQL

# The rate limit is raised because every test signs in, loads a page and its
# assets, and calls the API, all from one address: the default would throttle
# the suite rather than test it. Throttling is covered by the HTTP suite.
container="$(
  docker create \
    --add-host "${CONTAINER_POSTGRES_HOST}:host-gateway" \
    --publish "127.0.0.1:${HOST_PORT}:3000" \
    --env "DATABASE_URL=postgres://${APP_DB_USER}:${APP_DB_PASSWORD}@${CONTAINER_POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
    --env "MIGRATION_DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${CONTAINER_POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
    --env "PUBLIC_ORIGIN=${ORIGIN}" \
    --env "RATE_LIMIT_MAX=100000" \
    "$IMAGE"
)"
docker start "$container" >/dev/null
echo "ok: started ${IMAGE} as ${container}"

deadline=$(( $(date +%s) + BOOT_TIMEOUT_SECONDS ))
until curl --silent --fail --max-time 5 "${ORIGIN}/api/health" 2>/dev/null | grep -q '"reachable"'; do
  if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo false)" != "true" ]; then
    echo "FAIL: the container is no longer running" >&2
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "FAIL: ${ORIGIN}/api/health did not become healthy within ${BOOT_TIMEOUT_SECONDS}s" >&2
    exit 1
  fi
  sleep 2
done
echo "ok: the image is serving at ${ORIGIN}"

# Playwright fails when it finds no tests, so a suite that silently stopped
# being collected cannot pass here. Fixtures are arranged as the application's
# own login, as the HTTP suite arranges them, never as the schema owner.
BROWSER_TEST_BASE_URL="$ORIGIN" \
BROWSER_TEST_DATABASE_URL="postgres://${APP_DB_USER}:${APP_DB_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
  npx playwright test
