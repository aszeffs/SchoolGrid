#!/usr/bin/env bash
#
# Tests for scripts/verify-image.sh.
#
# That script is a security control, and an untested control is the problem
# issue #26 was about: it reported success for months while checking nothing.
# Its two failure modes are both silent. Anchor the paths wrongly and every
# absence check passes against an empty list; anchor them too narrowly and a
# base image that ships a shell somewhere unexpected sails through. Neither
# shows up as a red build.
#
# Docker is not needed here. `docker` is replaced by a test double, and each
# case is a fabricated image filesystem, so this runs anywhere bash and tar do.
#
# Usage: scripts/verify-image.test.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="${script_dir}/verify-image.sh"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

failures=0

# --- the docker test double -------------------------------------------------

mkdir -p "$workdir/bin"
cat > "$workdir/bin/docker" <<'DOUBLE'
#!/usr/bin/env bash
# Driven by FIXTURE (a directory standing in for the image rootfs) and by
# IMAGE_USER, IMAGE_ENTRYPOINT and IMAGE_CMD.
set -euo pipefail
case "$1" in
  create) echo "test-double-container" ;;
  rm)     exit 0 ;;
  export)
    args=("$@")
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [ "${args[$i]}" = "-o" ]; then out="${args[$((i + 1))]}"; fi
    done
    tar -cf "$out" -C "$FIXTURE" .
    ;;
  image)
    case "$4" in
      *Config.User*)       echo "${IMAGE_USER}" ;;
      *Config.Entrypoint*) echo "${IMAGE_ENTRYPOINT}" ;;
      *Config.Cmd*)        echo "${IMAGE_CMD}" ;;
    esac
    ;;
esac
DOUBLE
chmod +x "$workdir/bin/docker"

export PATH="$workdir/bin:$PATH"

# --- fixtures ---------------------------------------------------------------

# The image the Dockerfile is meant to produce. Every other fixture is this
# one with a single thing broken, so a failure names the breakage.
build_correct_image() {
  local root="$1"
  mkdir -p "$root/nodejs/bin" "$root/app/dist/db" "$root/app/migrations" \
           "$root/app/node_modules/fastify" "$root/app/node_modules/pg/bin" "$root/etc"
  touch "$root/nodejs/bin/node" \
        "$root/app/dist/index.js" "$root/app/dist/db/migrate.js" \
        "$root/app/package.json" "$root/app/migrations/0001_initial.sql" \
        "$root/app/node_modules/fastify/index.js" "$root/app/node_modules/pg/index.js" \
        "$root/etc/passwd"
  # A production dependency is allowed its own file called `sh`. If this trips
  # the shell check, the check is too broad and will block honest builds.
  touch "$root/app/node_modules/pg/bin/sh"
}

fixture() {
  local name="$1"
  local root="$workdir/fixtures/$name"
  mkdir -p "$root"
  build_correct_image "$root"
  echo "$root"
}

# --- the assertion ----------------------------------------------------------

# Asserts the exit code, and for a failing case that the output names the
# reason. A script that fails for the wrong reason is not passing this test.
expect() {
  local description="$1"
  local fixture_root="$2"
  local user="$3"
  local expected_code="$4"
  local expected_output="${5:-}"

  local output
  local code=0
  output="$(
    FIXTURE="$fixture_root" \
    IMAGE_USER="$user" \
    IMAGE_ENTRYPOINT='["/nodejs/bin/node"]' \
    IMAGE_CMD='["dist/index.js"]' \
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

correct="$(fixture correct)"
expect "a correct image passes" "$correct" "nonroot" 0 "all hardening checks passed"

# The regression an anchored search misses: the debug variants of the same
# distroless base ship busybox outside every system binary directory.
debug="$(fixture debug)"
mkdir -p "$debug/busybox" && touch "$debug/busybox/sh"
expect "a :debug base image is caught by its /busybox/sh" "$debug" "nonroot" 1 "contains a shell"

full="$(fixture full)"
mkdir -p "$full/bin" "$full/usr/bin"
touch "$full/bin/sh" "$full/bin/bash" "$full/usr/bin/apt-get" "$full/usr/bin/npm"
expect "a full Debian base is caught by its shell" "$full" "nonroot" 1 "contains a shell"
expect "a full Debian base is caught by its package manager" "$full" "nonroot" 1 "contains a package manager"

devdeps="$(fixture devdeps)"
mkdir -p "$devdeps/app/node_modules/typescript" "$devdeps/app/node_modules/vitest"
touch "$devdeps/app/node_modules/typescript/index.js" "$devdeps/app/node_modules/vitest/index.js"
expect "dev dependencies in the runtime stage are caught" "$devdeps" "nonroot" 1 "dev dependency (typescript)"

# The dev dependency names are read from package.json, so a manifest yielding
# none leaves the check with nothing to look for. That is the vacuous pass in
# a new place, and it has to be loud rather than green.
empty_manifest="$workdir/empty-manifest"
mkdir -p "$empty_manifest"
echo '{ "name": "no-dev-deps", "devDependencies": {} }' > "$empty_manifest/package.json"
export REPO_ROOT="$empty_manifest"
expect "a manifest with no dev dependencies is caught" "$correct" "nonroot" 1 "inspecting nothing"
unset REPO_ROOT

nomigrations="$(fixture nomigrations)"
rm -rf "$nomigrations/app/migrations"
expect "a dropped COPY of migrations is caught" "$nomigrations" "nonroot" 1 "missing from the runtime image: /app/migrations/"

expect "an empty User is caught" "$correct" "" 1 "runs as root"
expect "User=root:root is caught" "$correct" "root:root" 1 "runs as root"

# The other silent failure: if the export or the path patterns are wrong, the
# absence checks have nothing to match and all report success.
empty="$workdir/fixtures/empty"
mkdir -p "$empty" && touch "$empty/.keep"
expect "an empty export cannot pass vacuously" "$empty" "nonroot" 1 "no node binary found"

# --- verdict ----------------------------------------------------------------

echo
if [ "$failures" -gt 0 ]; then
  echo "${failures} test(s) failed" >&2
  exit 1
fi
echo "all tests passed"
