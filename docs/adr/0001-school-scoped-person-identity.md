# School-scoped Person identity

A Person exists within exactly one School, and no domain object spans Schools. The same human attending or working at two Schools is two unrelated Person records; only a User account, which holds no authorization and no academic data, may reach more than one School. We chose this over a Person spanning Schools because it makes the School boundary total: with nothing crossing it, Safe denial has nothing to leak and no query needs a cross-School guard.

## Consequences

- No district-level rollups, shared identity, or cross-School reporting without revisiting this.
- A departing Student's records stay with the origin School and travel nowhere. "Transfer" names a reason an Enrollment ended, not a movement of data; transcript exchange remains an office process outside the system.
- A parent with children at two Schools sees them through one login but two Persons, and revoking access at one School has no effect at the other.
