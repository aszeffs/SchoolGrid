#!/usr/bin/env bash
#
# Assert the hardening properties of a built runtime image.
#
# These are the properties issue #15 exists to produce, and the only honest way
# to hold them is to check the artifact rather than re-read the Dockerfile. A
# base image swapped for a convenient one, a `nonroot` suffix dropped in a
# rebase, a debugging shell copied in and forgotten — each of those is a
# one-line change that reads as harmless and quietly undoes the whole stage.
#
# The image has no shell, so nothing here can run *inside* it. The filesystem
# is exported and inspected from outside instead.
#
# Usage: scripts/verify-image.sh <image-ref>

set -euo pipefail

IMAGE="${1:?usage: verify-image.sh <image-ref>}"

workdir="$(mktemp -d)"
container=""

# Both the directory and the container are cleaned up here rather than inline,
# so that a failure between `docker create` and the end of the script does not
# leave a container behind on the runner.
cleanup() {
  if [ -n "$container" ]; then
    docker rm --force "$container" >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

pass() {
  echo "ok: $*"
}

# `docker export` writes tar entries without a leading `./`, but not every
# Docker version agrees about that, so both spellings are accepted. Writing
# this as `\./?` instead would demand a literal dot and match neither shape,
# which reads as "everything is fine" for the absence checks below.
ROOT='^(\./)?'

# --- the filesystem ---------------------------------------------------------

container="$(docker create "$IMAGE")"
docker export "$container" -o "$workdir/rootfs.tar"
tar -tf "$workdir/rootfs.tar" > "$workdir/files.txt"

# Search the whole filesystem, minus the application's own dependencies.
#
# Anchoring this to /bin, /usr/bin and friends would be wrong in the one case
# that matters. Distroless keeps nothing there: node lives at /nodejs/bin/node,
# and the `debug` variants of the same base image ship a shell at /busybox/sh.
# A Dockerfile edited to :debug-nonroot for a spot of troubleshooting would
# pass an anchored check while shipping a shell, which is exactly the
# regression this script exists to catch.
#
# node_modules is excluded instead, because a production dependency is allowed
# to carry a file of its own called `sh` and that is not a shell on the PATH.
grep -Ev "${ROOT}app/node_modules/" "$workdir/files.txt" > "$workdir/system-files.txt"

assert_absent() {
  local label="$1"
  local names="$2"
  local matches

  matches="$(grep -E "(^|/)(${names})\$" "$workdir/system-files.txt" || true)"
  if [ -n "$matches" ]; then
    fail "the runtime image contains a ${label}"
    echo "$matches" >&2
  else
    pass "no ${label} outside node_modules"
  fi
}

assert_absent "shell" 'sh|bash|dash|ash|zsh|ksh|busybox'
assert_absent "package manager" 'apt|apt-get|aptitude|dpkg|apk|yum|dnf|rpm|microdnf|npm|npx|pnpm|yarn'

# A check that can only ever pass is not a check. The runtime image must still
# contain the interpreter, so finding it proves the export and the patterns
# above are looking at a real filesystem rather than at an empty list.
if grep -Eq "${ROOT}nodejs/bin/node\$" "$workdir/files.txt"; then
  pass "the node binary is present, so these checks are reading a real filesystem"
else
  fail "no node binary found; the export or the path patterns are wrong, and the absence checks above prove nothing"
fi

# The other half of "only production dependencies ship". Every dev dependency
# is named rather than one canary, so a build that starts copying the wrong
# node_modules forward is caught whichever package arrives first.
for dev_dependency in typescript tsx vitest embedded-postgres @vitest/coverage-v8 @types/node @types/pg; do
  if grep -Eq "${ROOT}app/node_modules/${dev_dependency}/" "$workdir/files.txt"; then
    fail "a dev dependency (${dev_dependency}) is present in the runtime image"
  else
    pass "absent, as it should be: ${dev_dependency}"
  fi
done

for required in app/dist/index.js app/package.json app/migrations/; do
  if grep -Eq "${ROOT}${required}" "$workdir/files.txt"; then
    pass "present: /${required}"
  else
    fail "missing from the runtime image: /${required}"
  fi
done

# --- the image configuration ------------------------------------------------

user="$(docker image inspect --format '{{.Config.User}}' "$IMAGE")"
case "$user" in
  "" | 0 | 0:* | root | root:* )
    fail "the image runs as root (User='${user}')"
    ;;
  *)
    pass "runs as a non-root user (User='${user}')"
    ;;
esac

entrypoint="$(docker image inspect --format '{{json .Config.Entrypoint}}' "$IMAGE")"
cmd="$(docker image inspect --format '{{json .Config.Cmd}}' "$IMAGE")"
echo "entrypoint=${entrypoint} cmd=${cmd}"

case "$entrypoint" in
  *node*) pass "the entrypoint is node" ;;
  *)      fail "unexpected entrypoint: ${entrypoint}" ;;
esac

case "$cmd" in
  *dist/index.js*) pass "the entrypoint runs the compiled service" ;;
  *)               fail "the image does not run dist/index.js (Cmd=${cmd})" ;;
esac

# --- verdict ----------------------------------------------------------------

if [ "$failures" -gt 0 ]; then
  echo >&2
  echo "${failures} hardening check(s) failed for ${IMAGE}" >&2
  exit 1
fi

echo
echo "all hardening checks passed for ${IMAGE}"
