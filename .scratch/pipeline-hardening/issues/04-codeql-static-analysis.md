# 04: CodeQL static analysis

**What to build:** Static analysis of the application code on every pull request and on a weekly schedule, with findings landing in the repository's Security tab.

There is currently no static analysis at all. The weekly run matters as much as the pull request run: CodeQL's rules improve over time, and a scheduled scan finds old bugs with new rules in code nobody has changed.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A CodeQL workflow analyses JavaScript/TypeScript on pull requests to `dev` and `main`, and weekly.
- [ ] Results upload to code scanning and appear in the Security tab.
- [ ] The workflow declares least-privilege permissions, widening only where CodeQL requires it.
- [ ] Actions are SHA-pinned in the same style as ticket 01.
- [ ] A run has completed successfully and its findings — including zero findings — are confirmed visible in the Security tab.

---

**Note:** the codebase is small, so expect few findings. The value now is that the control grows with the code rather than being retrofitted onto a large codebase later.
