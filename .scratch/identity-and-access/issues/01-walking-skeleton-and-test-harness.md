# 01: Walking skeleton and test harness

**What to build:** A TypeScript service that boots, connects to PostgreSQL, applies migrations, and answers a single unauthenticated endpoint. Alongside it, the test harness every later ticket builds on: a real Postgres provisioned and migrated for the test run, and a helper that hands a test an HTTP client. No domain behaviour ships here.

This is explicitly a prefactor. It delivers no user-facing behaviour; it exists so that every following ticket is a small change rather than a large one. Its real deliverable is the harness, because it fixes the single test seam — the HTTP request boundary — before any code exists that could be tested below it.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The service starts, connects to Postgres, and serves one unauthenticated endpoint that confirms database connectivity.
- [ ] Migrations run forward from empty to current as a repeatable command, used by both the app and the test harness.
- [ ] The test suite provisions and migrates a real Postgres for the run; no test touches a fake or in-memory substitute.
- [ ] Tests are isolated from one another such that state written by one cannot be observed by another.
- [ ] A test helper returns an HTTP client that issues real requests against the running service, so no test needs to call a handler directly.
- [ ] The helper is the only documented way to make a request in a test, so later tickets are not tempted to bypass the boundary.
- [ ] The suite runs green from a clean checkout with a single command.

---

**Note for the implementer:** the seam is deliberate, not incidental. ADR-0002 guarantees that refusals are indistinguishable *to the caller*, which is only assertable where the caller stands. Do not add a second seam below HTTP for convenience later.
