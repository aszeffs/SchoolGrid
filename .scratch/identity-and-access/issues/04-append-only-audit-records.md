# 04: Append-only Audit records

**What to build:** The audit mechanism itself. A School Administrator can read their own School's Audit records, and nobody — including that Administrator, and including the application's own database role — can alter or delete one. A sensitive change and its Audit record commit together or not at all.

This ticket builds the machinery and proves its guarantees. Populating the trail with the events from earlier tickets is ticket 05's job; audit coverage of later mutations lands with each of those tickets as they are built.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] An Audit record carries actor, School, target, timestamp, action, reason, and relevant before/after values.
- [ ] Audit records contain no credentials and no Student data beyond what the entry needs.
- [ ] The append-only guarantee is enforced by database privilege, not by application convention: the application's role has no update or delete grant on the table.
- [ ] A test attempts to update and to delete an Audit record and is refused by the database.
- [ ] A sensitive mutation and its Audit record are written in one transaction; a test forces the audit write to fail and confirms the mutation rolled back with it.
- [ ] A School Administrator can read their own School's Audit records.
- [ ] A School Administrator reading another School's Audit records receives the standard refusal, indistinguishable from any other.
- [ ] The audit module's interface exposes append and School-scoped read only; no update or delete operation exists on it.

---

**Migrated to GitHub issue #6** (https://github.com/aszeffs/SchoolGrid/issues/6). That issue is the source of truth; this file is kept as a record.
