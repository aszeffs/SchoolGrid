# 06: School memberships and roles

**What to build:** A School Administrator can grant a Person a School membership carrying exactly one role, list the memberships in their School, and revoke one. A Person may hold several memberships at once, each granted, bounded, and revoked independently — so a Faculty member whose own child attends the School holds a Faculty membership and a Guardian membership that have nothing to do with each other.

Revoking one membership must leave every other membership held by the same Person untouched. That is the case this ticket exists to prove.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] A School Administrator can grant a Person a membership with one role.
- [ ] One Person can hold several memberships in their School simultaneously.
- [ ] Each membership carries its own bounds, so access begins and ends with the relationship.
- [ ] Revoking one membership leaves the Person's other memberships fully intact, proven for the teacher-parent case.
- [ ] A Person whose every membership has ended retains no access to the School.
- [ ] A caller may only manage memberships in a School they resolve into; attempts elsewhere return the standard refusal.
- [ ] Every grant, change, and revocation writes an Audit record in the same transaction.
- [ ] Authorization for these endpoints goes through the single decision point, not through inline role checks.
