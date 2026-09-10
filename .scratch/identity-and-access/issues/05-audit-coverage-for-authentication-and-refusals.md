# 05: Audit coverage for authentication and refusals

**What to build:** The two event classes that already exist but are not yet recorded. Every authentication attempt from ticket 02 and every refusal from ticket 03 now appears in the audit trail, so a School Administrator can see credential misuse and can detect someone probing for records they cannot reach.

This is where the two halves of Safe denial meet: the caller learns nothing about why they were refused, while the true reason — absent, cross-School, forbidden by role — is preserved for investigation. Routine successful reads are deliberately not recorded.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] Every authentication attempt, successful or failed, is recorded.
- [ ] Every refusal is recorded with its true internal reason, distinguishing absent, cross-School, and forbidden.
- [ ] The recorded reason never reaches the caller in any form, and the denial-equivalence suite from ticket 03 still passes unchanged.
- [ ] A failed authentication's audit entry does not disclose whether the account exists in a way that a School Administrator could not already determine.
- [ ] Successful routine reads produce no Audit record.
- [ ] A test establishes that a caller probing many identifiers leaves a visible trail while receiving uniform responses.

---

**Note for the implementer:** omitting successful reads is a deliberate choice, not an oversight — it keeps probing visible against a quiet background. Comment it so it is not "fixed" later.
