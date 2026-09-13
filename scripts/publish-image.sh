#!/usr/bin/env bash
#
# Push a verified local image to the registry, tagged with the commit that
# produced it and with `latest`.
#
# The commit tag is the one that matters. `latest` answers "what is newest",
# never "what is running": once a deployment has pulled it, the tag moves on and
# nothing on the image says which source it came from. The full SHA does, and it
# is what a provenance attestation for the image names.
#
# The commit tag is pushed first and `latest` only after it has landed, so
# `latest` can never point at an image the registry holds under no commit.
#
# `latest` moves only if the commit is still the head of the branch. Runs for
# two merges in quick succession finish in whichever order their checks do, and
# the older one finishing last would otherwise move `latest` backwards. It still
# gets its commit tag: it was merged, scanned and booted like any other.
#
# Writes `image` and `digest` to $GITHUB_OUTPUT when it is set. Later jobs pull
# by that digest rather than by tag, because a tag can be moved by a newer run
# between this job ending and theirs starting.
#
# Usage: scripts/publish-image.sh <local-image> <repository> <commit-sha> <branch-head-sha>

set -euo pipefail

USAGE="usage: publish-image.sh <local-image> <repository> <commit-sha> <branch-head-sha>"
LOCAL_IMAGE="${1:?$USAGE}"
REPOSITORY_ARG="${2:?$USAGE}"
COMMIT_SHA="${3-}"
BRANCH_HEAD="${4-}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# `github.repository` keeps the owner's capitalisation, and a registry refuses
# any uppercase in a repository name.
REPOSITORY="${REPOSITORY_ARG,,}"

# A mistyped expression in a workflow evaluates to an empty string rather than
# an error, and a short SHA can collide with another commit. Either would
# publish a tag that does not identify the source, which is the one thing the
# tag is for.
if ! [[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  fail "'${COMMIT_SHA}' is not a full commit SHA; nothing was pushed"
fi

# The same for the head. An empty one is a lookup that failed, and read as
# "some other commit" it would quietly stop `latest` from ever moving again.
if ! [[ "$BRANCH_HEAD" =~ ^[0-9a-f]{40}$ ]]; then
  fail "the branch head '${BRANCH_HEAD}' is not a full commit SHA; nothing was pushed"
fi

# Pushes one tag and stores the digest the registry reported in the variable
# named by $2. Assigned through a name rather than returned from `$(...)`, so a
# failure here ends the script instead of only the subshell.
push() {
  local ref="$1"
  local into="$2"
  local log
  log="$(mktemp)"

  docker tag "$LOCAL_IMAGE" "$ref"
  if ! docker push "$ref" 2>&1 | tee "$log"; then
    rm -f "$log"
    fail "the push of ${ref} failed"
  fi

  # A push can exit 0 without printing the digest line, and a missing digest
  # would be handed on as an empty reference for later jobs to pull.
  local found
  found="$(grep -Eo 'digest: sha256:[0-9a-f]{64}' "$log" | head -n 1 | cut -d ' ' -f 2 || true)"
  rm -f "$log"
  if [ -z "$found" ]; then
    fail "the push of ${ref} reported no digest"
  fi
  printf -v "$into" '%s' "$found"
}

push "${REPOSITORY}:${COMMIT_SHA}" digest
echo "ok: pushed ${REPOSITORY}:${COMMIT_SHA} as ${digest}"

# Written before `latest` is considered, because the commit image is published
# either way and later jobs pull and attest it either way.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "image=${REPOSITORY}"
    echo "digest=${digest}"
  } >> "$GITHUB_OUTPUT"
fi

if [ "$BRANCH_HEAD" != "$COMMIT_SHA" ]; then
  echo "ok: left ${REPOSITORY}:latest alone; ${COMMIT_SHA} is no longer the head (${BRANCH_HEAD} is)"
  exit 0
fi

push "${REPOSITORY}:latest" latest_digest
if [ "$latest_digest" != "$digest" ]; then
  fail "latest was pushed as ${latest_digest}, not the commit image ${digest}"
fi
echo "ok: moved ${REPOSITORY}:latest to ${digest}"
