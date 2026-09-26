# SchoolGrid

SchoolGrid is a K-12 academic records system for a School. Its first release demonstrates a complete, secure academic workflow while keeping the domain boundaries open for later growth.

## People and access

**School**:
The ownership and authorization boundary for all academic records. Every Person, academic structure, and record belongs to exactly one School, and no record is shared between Schools. A School has an explicit timezone, Instructional days, an Attendance window, and a Result value scale. Its timezone is fixed once its first Academic Year exists.
_Avoid_: Tenant, organization, campus

**Person**:
An individual as known to one School. A Person exists within exactly one School and holds every relationship they have with it. The same human at two Schools is two unrelated Persons. A Person need not be attached to a User account; one who never signs in, such as a young Student, is still a full Person.
_Avoid_: User, account

**User account**:
Credentials used to access SchoolGrid, identified by a username unique regardless of letter case and of look-alike spellings (equal after Unicode NFKC and case-folding). A User account holds no authorization and no academic data; it resolves to at most one Person per School and may reach more than one School.
_Avoid_: Person, role

**Session**:
A User account's proven presence, held by whoever signs in until it stops being live. A Session is live or it is not; it stops by being ended, by expiring, or by never having been recognised, and a caller cannot tell those apart (see Safe denial).
_Avoid_: Dead session, stale session, login

**Invitation**:
A School Administrator's offer that lets a human claim one Person in their School who is not yet attached to a User account. Redeeming it attaches that Person to a User account, new or existing. It grants no role; memberships, Enrollments, and Guardian links are granted separately. An Invitation is redeemable once, expires, and may be revoked by a School Administrator before redemption; the School Administrator delivers it to the human personally. A redemption by a User account that already resolves to a Person in that School is refused and leaves the Invitation redeemable.
_Avoid_: Sign-up, registration, account creation

**School membership**:
The scoped relationship granting a Person one role and its access boundary within a School. A Person may hold several memberships in their School, each granted, narrowed, and revoked independently.
_Avoid_: Role, account permission

**School Administrator**:
A School-scoped actor who configures the School, manages relationships, approves exceptional changes, and investigates Audit records.
_Avoid_: Admin, Platform Administrator

**Platform Administrator**:
An actor who operates the platform itself, provisioning Schools and their first School Administrator. A Platform Administrator has no access to any School-scoped record, including Audit records.
_Avoid_: School Administrator

**Trial School**:
A School a visitor starts for themselves from the public site, filled with invented data and private to them. It holds one User account per School role, none with a usable password; the visitor acts as a role by the trial issuing a Session for that role's account, never by signing in. It lives two hours: at expiry its Sessions stop being live, and it is later deleted whole, with every Person, record, Audit record and User account created in it (ADR-0012). A School that is not a Trial School is never deleted. A Trial School is started only by a Trial visitor, who has at most one live at a time; asking for another while it lives returns them to it.
_Avoid_: Demo, sandbox, tenant

**Trial visitor**:
Someone who has proven an outside identity, such as a GitHub or Google sign-in, in order to start or return to a Trial School. A Trial visitor is not a User account and not a Person: SchoolGrid knows them only by that outside identity, with no name or email, and forgets them once no Trial School of theirs remains.
_Avoid_: Visitor account, guest, trial user

**Faculty**:
A School-scoped actor assigned to teach one or more Class Offerings and record academic activity for their assigned rosters.
_Avoid_: Teacher

**Student**:
A learner with an Enrollment in a School whose own published academic records are visible to them.
_Avoid_: Pupil

**Guardian**:
An actor linked to one specific Student through an explicit relationship and Access profile. A Guardian holds one link per Student, each ending with that Student's Enrollment.
_Avoid_: Parent, family member

**Access profile**:
A per-Student Guardian permission set composed of two independent permissions: attendance read and results read.
_Avoid_: Global Guardian role, full academic read

**Safe denial**:
The single response given whenever access is refused, identical for a record that is absent, outside the actor's School, or present but forbidden. The reason for a refusal is written only to the Audit record and never disclosed to the actor.
_Avoid_: Error, permission error

## Academic structure

**Academic Year**:
A named School period partitioned into ordered, non-overlapping Terms. Academic Years never overlap, but may leave School dates between them, such as a summer break, that fall in no Academic Year.
_Avoid_: School year

**Term**:
An ordered, bounded period within an Academic Year in which Class Offerings operate. Terms neither overlap nor leave gaps, so every School date within an Academic Year falls in exactly one Term. A Term is the period against which results are recorded.
_Avoid_: Semester, marking period

**Course**:
A reusable subject definition that may be offered in multiple Terms.
_Avoid_: Class

**Class Offering**:
A Course offered for one Term, with time-bounded Faculty assignments and roster membership.
_Avoid_: Class, section

**Course sequence**:
An ordered set of Class Offerings of one Course across consecutive Terms in an Academic Year, which a Student is expected to continue through. It expresses continuity only; each offering keeps its own roster, results, and Publication.
_Avoid_: Year-long class, multi-term course

**Enrollment**:
A Student's bounded participation in a School. Enrollment history is retained when a Student departs. Ending an Enrollment ends each of the Student's Roster memberships that runs past it, removing one not yet begun, and ends every linked Guardian's access, narrows the Student's own access to their published records and the Roster memberships those records belong to, and leaves every record in place. A departing Student's records stay with the School and travel nowhere.
_Avoid_: Registration, transfer

**Roster membership**:
A Student's participation in a Class Offering, bounded by School dates. A Student may have multiple memberships across offerings in one Term, and more than one in the same offering so long as their dates never overlap: a Student who left part way through may be rostered again.
_Avoid_: Enrollment

**Teaching assignment**:
A Faculty member's assignment to a Class Offering, bounded by School dates. It requires an active Faculty School membership, and ending that membership ends each of the Faculty member's Teaching assignments that runs past it, removing one not yet begun. Multiple Faculty members may be assigned concurrently. A Faculty member who was ever assigned may read that Class Offering's whole history; recording, publishing, and correcting require a currently active assignment.
_Avoid_: Class owner

**Conflict of interest**:
The condition where a Faculty member records or publishes for a Student they are also linked to as a Guardian. It is permitted and marked on the resulting Audit record for a School Administrator to review.
_Avoid_: Self-dealing, related-party

## Academic records

**School date**:
A calendar date as observed in the School's timezone. Academic records that describe a school day are identified by this date rather than by an instant.
_Avoid_: Timestamp, date, school calendar date

**Instructional day**:
A School date on which a School is in session, configured per Academic Year as a weekday pattern with dated exceptions. Attendance may exist only on an Instructional day within its Term. A School date may later stop being an Instructional day; Attendance already recorded on it remains, no longer counting toward attendance totals.
_Avoid_: School day, session day

**Attendance**:
One Student's status for one Class Offering on one School date. Supported statuses are Present, Tardy, Excused absence, Unexcused absence, and Absent-pending-review, with at most one Attendance record for that Student, offering, and date. Attendance is readable by permitted actors as soon as it is recorded. It is recorded only by Faculty whose Teaching assignment both covers that School date and is currently active, for a School date no later than the School's today; every other change, including any by a School Administrator, goes through a Correction request.
_Avoid_: Presence record

**Attendance totals**:
For one Student in one Class Offering and Term, the count of each Attendance status over Instructional days, plus Not recorded: the Instructional days up to the School's today, within the Student's Roster membership, that have no Attendance. Attendance on a School date that is no longer an Instructional day is not counted.
_Avoid_: Attendance rate, attendance summary

**Absent-pending-review**:
An Attendance status recorded by Faculty when the reason for an absence is not yet established. It is visible to permitted actors immediately and is resolved to another status by a School Administrator through a Correction request, whether or not the Attendance window is open.
_Avoid_: Unknown absence, provisional absence

**Attendance window**:
The duration, configured per School and measured from each School date, in which Faculty may record or correct that date's Attendance normally. Changes after it closes require a Correction request. The current setting applies to every School date, so changing it opens or closes past dates at once.
_Avoid_: Edit period

**Attendance session**:
The Faculty workflow for recording Attendance for a Roster snapshot on one School date. A session may be saved while some roster members remain unmarked and may be reopened for normal-window corrections. There is one session per Class Offering and School date, shared by every Faculty member who may record it; a mark changed by someone else since it was loaded is refused rather than overwritten.
_Avoid_: Attendance form, class check-in

**Roster snapshot**:
The set of Roster memberships captured when an Attendance session opens. Later roster changes never remove captured members. While the Attendance window is open the snapshot may be refreshed, which adds newly active members only. A captured member whose Enrollment has ended remains visible but can receive no Attendance for dates after it ended.
_Avoid_: Live roster, attendance list

**Result value scale**:
The versioned list of allowed result values a School permits, such as A through F. Each Term result is bound to the version in force when it was recorded, so changing the scale never alters an existing result.
_Avoid_: Grading scale, rubric

**Term result**:
A Faculty-created academic result for a Student in a Class Offering for one Term. It begins as a draft and carries a value from the School's Result value scale, an optional numeric score, and an optional comment. Drafts are visible only to Faculty ever assigned to that Class Offering and to School Administrators. Changing a draft's value binds it to the scale version then in force; an untouched draft keeps its version, and a published result never changes version.
_Avoid_: Grade, marking-period result, assignment grade

**Term report**:
One Student's view of one Term: each Class Offering they were rostered in, with its published Term result and Attendance totals. A Guardian sees only the parts their Access profile grants, with nothing marking what is withheld.
_Avoid_: Report card, transcript

**Publication**:
The irreversible transition making one Student's Term result visible to that Student and to permitted Guardians. It is performed for a Class Offering at once, publishing every result carrying a value at that moment, and is refused while any active roster member's result lacks a value. A result created afterwards is published by a later act without reversing or re-asserting anything. Publication applies to results only; Attendance does not publish.
_Avoid_: Approval, release

**Correction request**:
A record of a proposed change requiring School Administrator approval: Attendance outside its window, resolution of an Absent-pending-review, or a published Term result. It carries the requester, a reason, the before and after values, its state, and the approver, and may be raised at any time with no deadline. Faculty and School Administrators may raise one; a School Administrator other than the requester approves it, unless the School has a single Administrator, whose self-approval is marked on the Audit record. Approval applies the change and records it in the same transaction. A Correction request is Pending until it is Approved, Rejected with a reason, or Withdrawn by its requester. Approval is refused while the target's current value differs from the request's before value, which is none when the request adds Attendance where none was recorded. Faculty may raise one only for a Class Offering they are currently assigned to.
_Avoid_: Edit request, change ticket

**Audit record**:
An append-only trace of an authentication event, a Safe denial, a sensitive academic mutation, or a School configuration change. It carries actor, School, target, timestamp, action, reason, and relevant before/after values without credentials or unnecessary Student data. No actor may alter or delete one, and it outlives the Enrollment it describes. The one exception is the deletion of a whole expired Trial School, which takes its Audit records with it. Successful routine reads are not audited, nor is a first Attendance mark, which carries its own recorder and time; changing one is audited.
_Avoid_: Log entry
