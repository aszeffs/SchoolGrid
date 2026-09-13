#!/usr/bin/env bash
#
# Tests for scripts/publish-image.sh.
#
# Publication is the one step in the pipeline whose mistakes leave the
# repository and cannot be taken back by a revert: a tag in a public registry
# has been pulled by whoever pulled it. The failure modes worth guarding are the
# quiet ones — `latest` moved to an image with no commit tag beside it, a tag
# built from an empty or abbreviated SHA, a push that reported nothing and was
# read as a success.
#
# Docker is not needed here. `docker` is replaced by a test double driven by a
# SCENARIO that records every call it receives, so each case asserts on what
# was pushed, and in what order, and this runs anywhere bash does.
#
# Usage: scripts/publish-image.test.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="${script_dir}/publish-image.sh"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

failures=0

SHA="0123456789abcdef0123456789abcdef01234567"
DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

# --- the double -------------------------------------------------------------

mkdir -p "$workdir/bin"

cat > "$workdir/bin/docker" <<'DOUBLE'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$STATE/calls"
case "$1" in
  tag) ;;
  push)
    ref="$2"
    if [ "$SCENARIO" = "commit-push-fails" ] && [ "${ref##*:}" != "latest" ]; then
      echo "denied: permission_denied: write_package" >&2
      exit 1
    fi
    echo "The push refers to repository [${ref%:*}]"
    echo "5f70bf18a086: Pushed"
    if [ "$SCENARIO" = "no-digest" ]; then
      exit 0
    fi
    echo "${ref##*:}: digest: ${DOUBLE_DIGEST} size: 1234"
    ;;
  *) echo "double: unexpected docker $*" >&2; exit 64 ;;
esac
DOUBLE

chmod +x "$workdir/bin/docker"
export PATH="$workdir/bin:$PATH"

# --- running a case ---------------------------------------------------------
#
# Each case gets its own state directory, so the call log it asserts on holds
# only the calls that case made.

output=""
code=0
state=""

run_case() {
  local description="$1"
  local scenario="$2"
  local repository="$3"
  local sha="$4"

  current="$description"
  state="$workdir/state/$description"
  mkdir -p "$state"
  : > "$state/calls"
  : > "$state/github-output"

  code=0
  output="$(
    SCENARIO="$scenario" \
    STATE="$state" \
    DOUBLE_DIGEST="$DIGEST" \
    GITHUB_OUTPUT="$state/github-output" \
    bash "$subject" schoolgrid:test "$repository" "$sha" 2>&1
  )" || code=$?
}

report() {
  echo "FAIL: ${current}" >&2
  echo "  $1" >&2
  echo "$output" | sed 's/^/  | /' >&2
  echo "  docker calls:" >&2
  sed 's/^/  > /' "$state/calls" >&2
  failures=$((failures + 1))
}

expect_code() {
  if [ "$code" -ne "$1" ]; then report "expected exit $1, got ${code}"; fi
}

expect_output() {
  if ! echo "$output" | grep -qF -- "$1"; then report "the output never said: $1"; fi
}

expect_call() {
  if ! grep -qxF -- "$1" "$state/calls"; then report "docker was never called with: $1"; fi
}

expect_no_push() {
  if grep -q '^push' "$state/calls"; then report "something was pushed"; fi
}

expect_no_call_matching() {
  if grep -qE -- "$1" "$state/calls"; then report "docker was called matching: $1"; fi
}

expect_no_output() {
  if echo "$output" | grep -qF -- "$1"; then report "the output said, and should not have: $1"; fi
}

expect_github_output() {
  if ! grep -qxF -- "$1" "$state/github-output"; then report "GITHUB_OUTPUT never received: $1"; fi
}

# --- the cases --------------------------------------------------------------

# The path that runs on every merge: both tags pushed, commit tag first.
run_case "a clean publish pushes the commit tag and latest" ok ghcr.io/aszeffs/schoolgrid "$SHA"
expect_code 0
expect_call "tag schoolgrid:test ghcr.io/aszeffs/schoolgrid:${SHA}"
expect_call "push ghcr.io/aszeffs/schoolgrid:${SHA}"
expect_call "tag schoolgrid:test ghcr.io/aszeffs/schoolgrid:latest"
expect_call "push ghcr.io/aszeffs/schoolgrid:latest"

# Order is the property. `latest` pointing at an image that has no commit tag
# is exactly the untraceable deployment the commit tag exists to prevent.
run_case "the commit tag is pushed before latest" ok ghcr.io/aszeffs/schoolgrid "$SHA"
pushes="$(grep '^push' "$state/calls" || true)"
if [ "$pushes" != "push ghcr.io/aszeffs/schoolgrid:${SHA}"$'\n'"push ghcr.io/aszeffs/schoolgrid:latest" ]; then
  report "pushes were not the commit tag followed by latest"
fi

# The digest is what a later job pulls and attests, rather than a tag that a
# newer run may already have moved.
run_case "the pushed digest is handed to later steps" ok ghcr.io/aszeffs/schoolgrid "$SHA"
expect_github_output "image=ghcr.io/aszeffs/schoolgrid"
expect_github_output "digest=${DIGEST}"

# `github.repository` keeps the owner's capitalisation, and registries refuse
# any uppercase in a repository name.
run_case "the repository is lowercased" ok ghcr.io/aszeffs/SchoolGrid "$SHA"
expect_code 0
expect_call "push ghcr.io/aszeffs/schoolgrid:${SHA}"
expect_github_output "image=ghcr.io/aszeffs/schoolgrid"

# A mistyped expression evaluates to an empty string in a workflow, not an
# error, and an abbreviated SHA can collide. Either would publish a tag that
# does not identify a commit.
run_case "an empty commit SHA is refused before anything is pushed" ok ghcr.io/aszeffs/schoolgrid ""
expect_code 1
expect_output "not a full commit SHA"
expect_no_push

run_case "an abbreviated commit SHA is refused before anything is pushed" ok ghcr.io/aszeffs/schoolgrid "${SHA:0:7}"
expect_code 1
expect_output "not a full commit SHA"
expect_no_push

# If the commit tag did not land, `latest` must not move. The reason matters as
# well as the exit: without `pipefail` the push status is lost in the pipe to
# `tee`, and this would fail later and misleadingly as a push with no digest.
run_case "a failed commit push leaves latest untouched" commit-push-fails ghcr.io/aszeffs/schoolgrid "$SHA"
expect_code 1
expect_output "permission_denied"
expect_output "the push of ghcr.io/aszeffs/schoolgrid:${SHA} failed"
expect_no_output "reported no digest"
expect_no_call_matching ':latest$'

# A push that printed no digest has told us nothing about what the registry
# holds, and later steps would pull and attest an empty reference.
run_case "a push that reports no digest fails" no-digest ghcr.io/aszeffs/schoolgrid "$SHA"
expect_code 1
expect_output "reported no digest"
expect_no_call_matching ':latest$'

# --- verdict ----------------------------------------------------------------

echo
if [ "$failures" -gt 0 ]; then
  echo "${failures} assertion(s) failed" >&2
  exit 1
fi
echo "all tests passed"
