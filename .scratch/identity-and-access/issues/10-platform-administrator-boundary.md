# 10: Platform Administrator boundary

**What to build:** The exclusion guarantee, verified once every School-scoped endpoint exists. A Platform Administrator operates the platform — creating Schools and provisioning each School's first School Administrator — and is refused by every School-scoped endpoint in the system, including the audit trail. Actions a Platform Administrator takes against a School appear in that School's own Audit records, so a School Administrator can see what was done to their School from outside it.

This lands last because the guarantee is only meaningful when there is a full surface to be excluded from. Ticket 03 built just enough platform capability to bootstrap; this ticket hardens it and proves the boundary holds everywhere.

**Blocked by:** 09.

**Status:** ready-for-agent

- [ ] A Platform Administrator can create a School and provision its first School Administrator.
- [ ] A Platform Administrator is refused by every School-scoped endpoint, receiving the same response any other unauthorized caller receives.
- [ ] A Platform Administrator cannot read any School's Audit records.
- [ ] An exhaustive test enumerates every School-scoped endpoint and asserts refusal for a Platform Administrator, so a future endpoint added without thought fails this suite.
- [ ] Platform-level actions against a School are recorded in that School's Audit records and are visible to its School Administrator.
- [ ] A Platform Administrator holds no School membership and cannot grant themselves one.

---

**Note for the implementer:** the enumeration test is the point of this ticket. A guarantee asserted for the endpoints that existed when it was written is worth much less than one that fails loudly when someone adds an endpoint that forgot about it.

---

**Migrated to GitHub issue #12** (https://github.com/aszeffs/SchoolGrid/issues/12). That issue is the source of truth; this file is kept as a record.
