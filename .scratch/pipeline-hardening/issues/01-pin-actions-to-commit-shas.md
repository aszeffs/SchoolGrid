# 01: Pin actions to commit SHAs

**What to build:** Every `uses:` reference in every workflow points at a full 40-character commit SHA instead of a mutable tag, with a trailing comment naming the human-readable version so the file stays readable.

A tag is a pointer that whoever controls the action's repository can move. When `tj-actions/changed-files` was compromised, attacker code ran inside thousands of pipelines with their tokens, and every one of those pipelines had done nothing wrong except trust a tag. A SHA cannot be repointed.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Every `uses:` across all workflows references a full 40-character commit SHA.
- [x] Each pinned reference carries a trailing comment with its version, e.g. `# v4.2.2`.
- [x] Each SHA is verified to be the commit the named version tag actually points at, not merely a recent commit on the default branch.
- [x] All workflows still pass after pinning.

## Comments

**2026-09-11 — pinned.**

Every `uses:` across all five workflows now references a 40-character commit SHA with a trailing version comment.

| Action | Version | SHA |
| --- | --- | --- |
| `actions/checkout` | v4.4.0 | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-node` | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/upload-artifact` | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/dependency-review-action` | v4.9.0 | `2031cfc080254a8a887f58cffee85186f0e49e48` |
| `gitleaks/gitleaks-action` | v2.3.9 | `ff98106e4c7b2bc287b24eaf42907196329070c7` |
| `github/codeql-action/init` | v4.38.0 | `b96794f015dfd88f77b49b1c93e0fa7110f94c63` |
| `github/codeql-action/analyze` | v4.38.0 | `b96794f015dfd88f77b49b1c93e0fa7110f94c63` |

Each SHA was resolved through the GitHub git-refs API from the version tag itself, dereferencing annotated tag objects to the commit they point at, rather than being read off the default branch. A tag whose object type is `tag` resolves to a tag object whose own `object.sha` is the commit; taking the first SHA would have pinned the annotation, not the code.

Two decisions worth recording. The existing workflows referenced floating majors — `actions/checkout@v4` while v7 exists — and this ticket pins rather than upgrades, so each was pinned to the newest patch within the major already in use. Ticket 02's Dependabot config raises the major bumps individually, which is where they get read. The two actions introduced by tickets 03 and 04 had no prior version to preserve and were pinned to current latest.
