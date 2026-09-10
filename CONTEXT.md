# SchoolGrid

SchoolGrid is a K-12 academic records system for a School. Its first release demonstrates a complete, secure academic workflow while keeping the domain boundaries open for later growth.

## People and access

**School**:
The ownership and authorization boundary for all academic records. Every Person, academic structure, and record belongs to exactly one School, and no record is shared between Schools. A School has an explicit timezone, Instructional days, an Attendance window, and a Result value scale.
_Avoid_: Tenant, organization, campus

**Person**:
An individual as known to one School. A Person exists within exactly one School and holds every relationship they have with it. The same human at two Schools is two unrelated Persons.
_Avoid_: User, account

**User account**:
Credentials and authentication state used to access SchoolGrid. A User account holds no authorization and no academic data; it resolves to at most one Person per School and may reach more than one School.
_Avoid_: Person, role

**School membership**:
The scoped relationship granting a Person one role and its access boundary within a School. A Person may hold several memberships in their School, each granted, narrowed, and revoked independently.
_Avoid_: Role, account permission

**School Administrator**:
A School-scoped actor who configures the School, manages relationships, approves exceptional changes, and investigates Audit records.
_Avoid_: Admin, Platform Administrator

**Platform Administrator**:
An actor who operates the platform itself, provisioning Schools and their first School Administrator. A Platform Administrator has no access to any School-scoped record, including Audit records.
_Avoid_: School Administrator

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
A named School period partitioned into ordered, non-overlapping Terms.
_Avoid_: School year

**Term**:
An ordered, bounded period within an Academic Year in which Class Offerings operate. Terms neither overlap nor leave gaps, so every School date falls in exactly one Term. A Term is the period against which results are recorded.
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
A Student's bounded participation in a School. Enrollment history is retained when a Student departs. Ending an Enrollment ends the Student's open Roster memberships and every linked Guardian's access, narrows the Student's own access to their published records, and leaves every record in place. A departing Student's records stay with the School and travel nowhere.
_Avoid_: Registration, transfer

**Roster membership**:
A Student's bounded participation in a Class Offering. A Student may have multiple memberships across offerings in one Term.
_Avoid_: Enrollment

**Teaching assignment**:
A Faculty member's bounded assignment to a Class Offering. Multiple Faculty members may be assigned concurrently. A Faculty member who was ever assigned may read that Class Offering's whole history; recording, publishing, and correcting require a currently active assignment.
_Avoid_: Class owner

**Conflict of interest**:
The condition where a Faculty member records or publishes for a Student they are also linked to as a Guardian. It is permitted and marked on the resulting Audit record for a School Administrator to review.
_Avoid_: Self-dealing, related-party

## Academic records

**School date**:
A calendar date as observed in the School's timezone. Academic records that describe a school day are identified by this date rather than by an instant.
_Avoid_: Timestamp, date, school calendar date

**Instructional day**:
A School date on which a School is in session, configured per Academic Year. Attendance may exist only on an Instructional day within its Term. A School date may later stop being an Instructional day; Attendance already recorded on it remains, no longer counting toward attendance totals.
_Avoid_: School day, session day

**Attendance**:
One Student's status for one Class Offering on one School date. Supported statuses are Present, Tardy, Excused absence, Unexcused absence, and Absent-pending-review, with at most one Attendance record for that Student, offering, and date. Attendance is readable by permitted actors as soon as it is recorded.
_Avoid_: Presence record

**Absent-pending-review**:
An Attendance status recorded by Faculty when the reason for an absence is not yet established. It is visible to permitted actors immediately and is resolved to another status by a School Administrator through a Correction request, whether or not the Attendance window is open.
_Avoid_: Unknown absence, provisional absence

**Attendance window**:
The duration, configured per School and measured from each School date, in which Faculty may record or correct that date's Attendance normally. Changes after it closes require a Correction request.
_Avoid_: Edit period

**Attendance session**:
The Faculty workflow for recording Attendance for a Roster snapshot on one School date. A session may be saved while some roster members remain unmarked and may be reopened for normal-window corrections.
_Avoid_: Attendance form, class check-in

**Roster snapshot**:
The set of Roster memberships captured when an Attendance session opens. Later roster changes never remove captured members. While the Attendance window is open the snapshot may be refreshed, which adds newly active members only. A captured member whose Enrollment has ended remains visible but can receive no Attendance for dates after it ended.
_Avoid_: Live roster, attendance list

**Result value scale**:
The versioned list of allowed result values a School permits, such as A through F. Each Term result is bound to the version in force when it was recorded, so changing the scale never alters an existing result.
_Avoid_: Grading scale, rubric

**Term result**:
A Faculty-created academic result for a Student in a Class Offering for one Term. It begins as a draft and carries a value from the School's Result value scale, an optional numeric score, and an optional comment. Drafts are visible only to Faculty ever assigned to that Class Offering and to School Administrators.
_Avoid_: Grade, marking-period result, assignment grade

**Publication**:
The irreversible transition making one Student's Term result visible to that Student and to permitted Guardians. It is performed for a Class Offering at once, publishing every result carrying a value at that moment, and is refused while any active roster member's result lacks a value. A result created afterwards is published by a later act without reversing or re-asserting anything. Publication applies to results only; Attendance does not publish.
_Avoid_: Approval, release

**Correction request**:
A record of a proposed change requiring School Administrator approval: Attendance outside its window, resolution of an Absent-pending-review, or a published Term result. It carries the requester, a reason, the before and after values, its state, and the approver, and may be raised at any time with no deadline. Faculty and School Administrators may raise one; a School Administrator other than the requester approves it, unless the School has a single Administrator, whose self-approval is marked on the Audit record. Approval applies the change and records it in the same transaction.
_Avoid_: Edit request, change ticket

**Audit record**:
An append-only trace of an authentication event, a Safe denial, a sensitive academic mutation, or a School configuration change. It carries actor, School, target, timestamp, action, reason, and relevant before/after values without credentials or unnecessary Student data. No actor may alter or delete one, and it outlives the Enrollment it describes. Successful routine reads are not audited.
_Avoid_: Log entry
