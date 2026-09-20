# Cursor pagination for Audit records alone

`GET /api/schools/:schoolId/audit-records` takes a cursor and returns one page. No other list endpoint paginates: Persons, Invitations, memberships, Enrollments, and Guardian links are returned whole and filtered in the browser. Audit records are the only collection with no upper bound — they are append-only, no actor may alter or delete one, and they outlive the Enrollments they describe — so a screen that fetched them whole would eventually hang the browser and the server together. The other lists are bounded by the size of a School, where a request per page costs more than it saves and client-side filtering is faster for the user. We rejected paginating everything for consistency: it is real work and a real complication on five endpoints that do not need it.

## Consequences

- Ordering must be stable, so paging cannot skip or repeat a record while new ones are being written behind it. A cursor over an ordered key does this; an offset does not.
- A malformed cursor is rejected as malformed, and only after the Access decision. Validated first, it would answer differently depending on what the caller may see, which is what ADR-0002 forbids.
- The two shapes of list response are a deliberate inconsistency, not an oversight, and a contributor tidying it into one shape would be undoing this decision. When another list outgrows its bound, it gets the same cursor treatment and is recorded here.
- The public demo accumulates Audit records every night, so this endpoint is the first to feel the absence of a bound in practice, not in theory.
