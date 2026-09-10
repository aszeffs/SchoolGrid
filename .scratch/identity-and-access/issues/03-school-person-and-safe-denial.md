# 03: School, Person, and the Safe denial chokepoint

**What to build:** Schools and Persons exist, and a caller can act within one. An authenticated caller can list the Schools their account reaches, and read and list Persons inside a School their account resolves into. A Person belongs to exactly one School and the same human at two Schools is two unrelated records with nothing linking them.

This is the first School-scoped resource in the system, which makes it the first thing that can be refused — so the single refusal chokepoint lands here rather than being retrofitted. Every denial in the system is produced in one place and returns one response: a record that is absent, a record in another School, and a record the caller may not read are byte-identical to the caller.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] A School can be created together with its first School Administrator, sufficient to bootstrap the rest of the tickets.
- [ ] An authenticated caller can list the Schools their account reaches.
- [ ] A caller acting in a School has their request resolved to their Person in that School, or refused if there is none.
- [ ] A Person carries a mandatory School and no table permits a row referencing two Schools.
- [ ] A caller can read and list Persons within a School they resolve into.
- [ ] Every School-scoped request passes through a single authorization decision; no handler consults a role or membership directly.
- [ ] Refusals are produced in exactly one place and are not parameterised by reason, so no handler can construct a custom refusal message.
- [ ] A denial-equivalence suite proves that an absent record, a cross-School record, and a forbidden record produce identical status, identical body, and no distinguishing headers.
- [ ] Listings omit records the caller may not read, rather than redacting them or signalling that they were withheld.
- [ ] A caller with no Person in a School is refused exactly as an unauthenticated caller would be.

---

**Note for the implementer:** ADR-0001 and ADR-0002 both land here. The uniform refusal will read as unhelpful error handling — it is deliberate. Comment it at the chokepoint so it is not "improved" later.
