# 01: Pin actions to commit SHAs

**What to build:** Every `uses:` reference in every workflow points at a full 40-character commit SHA instead of a mutable tag, with a trailing comment naming the human-readable version so the file stays readable.

A tag is a pointer that whoever controls the action's repository can move. When `tj-actions/changed-files` was compromised, attacker code ran inside thousands of pipelines with their tokens, and every one of those pipelines had done nothing wrong except trust a tag. A SHA cannot be repointed.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Every `uses:` across all workflows references a full 40-character commit SHA.
- [ ] Each pinned reference carries a trailing comment with its version, e.g. `# v4.2.2`.
- [ ] Each SHA is verified to be the commit the named version tag actually points at, not merely a recent commit on the default branch.
- [ ] All workflows still pass after pinning.
