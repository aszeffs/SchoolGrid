# 09: Re-enrollment and access widening

**What to build:** A Student who departed and returns the following year regains full access automatically, with no administrator repair step and no manual restoration. Their prior Enrollments and every record attached to them remain intact and readable alongside the new one.

This ticket is the payoff for ticket 08's decision to derive access rather than store it. If access widens without anyone restoring it, the derivation is correct. If it does not, something stored a flag.

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] A Student with an ended Enrollment can be given a new Enrollment in the same School, as the same Person.
- [ ] The new Enrollment restores full Student access with no separate restoration step.
- [ ] Prior Enrollments and their records remain intact and readable after the return.
- [ ] Guardian links are not silently restored by re-enrolment; a School Administrator links Guardians afresh.
- [ ] A test walks the full lifecycle in one pass — enrol, depart, confirm narrowed access, return, confirm widened access — asserting through the HTTP boundary at each stage.
- [ ] The re-enrolment writes an Audit record, and the whole lifecycle is reconstructable from the trail.

---

**Migrated to GitHub issue #11** (https://github.com/aszeffs/SchoolGrid/issues/11). That issue is the source of truth; this file is kept as a record.
