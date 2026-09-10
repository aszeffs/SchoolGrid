# 07: Guardian links and Access profiles

**What to build:** A School Administrator can link a Guardian to one specific Student and set that link's Access profile, then change or revoke it. The profile is two independent permissions — attendance read and results read — not three named modes, so any combination is expressible.

A Guardian's access is per-Student and nothing widens it. A Guardian of two Students holds two separate links with two separate profiles, and reaches no Student they are not linked to.

The profile is stored, validated, and returned here, but there is nothing yet to gate with it: Attendance and Term results do not exist. Enforcement lands with those slices. Modelling it now means they do not have to reopen the question.

**Blocked by:** 06.

**Status:** ready-for-agent

- [ ] A Guardian can be linked to one specific Student, with the link scoped to that Student alone.
- [ ] Each link carries an Access profile of two independent permissions, and all four combinations are expressible and persisted.
- [ ] A Guardian linked to two Students has two independent links and profiles; changing one does not affect the other.
- [ ] A Guardian reaches no Student they are not explicitly linked to, receiving the standard refusal.
- [ ] A School Administrator can change a link's profile and can revoke the link entirely.
- [ ] Every link creation, change, and revocation writes an Audit record in the same transaction.
- [ ] No endpoint yet consumes the profile's permissions; they are stored and returned only.
