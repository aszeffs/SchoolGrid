# 08: Enrollment and Student departure

**What to build:** A School Administrator can record a Student's Enrollment and later end it. Enrolling gives the Student access to their own records. Ending the Enrollment narrows that access to their own published records, ends every linked Guardian's access to them, and leaves every record in place.

Crucially, the narrowing is **derived** from whether an open Enrollment exists — never stored as a flag on the membership. Ticket 09 depends on that: if it is stored, re-enrolment needs a repair step, and a stored flag can drift out of step with the Enrollment it describes.

Departure is departure only. Records stay with the School and travel nowhere; "transfer" names a reason an Enrollment ended, not a movement of data.

**Blocked by:** 07.

**Status:** ready-for-agent

- [ ] A School Administrator can record a Student's Enrollment, granting them access to their own records.
- [ ] A School Administrator can end an Enrollment with a recorded reason.
- [ ] A Student whose Enrollment has ended retains access to their own published records.
- [ ] That Student has no access to anything unpublished, and no access to any other Student.
- [ ] Ending an Enrollment ends every Guardian link to that Student.
- [ ] A Guardian linked to two Students, one of whom departs, retains full access to the other.
- [ ] Ended Enrollments are retained, never deleted, and prior Enrollments remain readable.
- [ ] Whether a Student's access is full or narrowed is computed from Enrollment state at request time; no stored flag records it.
- [ ] No endpoint exports or transmits a departing Student's records anywhere.
- [ ] Enrollment creation and ending each write an Audit record in the same transaction.

---

**Note for the implementer:** the asymmetry here looks arbitrary and is not — a departed Student still needs their own transcript, whereas a Guardian's standing derives from an active relationship to the School.
