# Identity and Access

Status: ready-for-agent

## Problem Statement

SchoolGrid holds academic records belonging to a School, and every one of those records is sensitive. Before a single Attendance record or Term result can be built, the system needs an answer to three questions it currently cannot answer at all: who is making this request, which School's records may they touch, and what happens when the answer is "none of them".

Getting this wrong is not a bug that shows up as a broken page. It shows up as one School reading another School's Students, a Guardian discovering which Students exist by probing for records they cannot read, or a departed Faculty member retaining access to a roster. These failures are silent, they are discovered late, and in a K-12 records system they are the failures that matter most.

There is also a subtler problem. The domain model deliberately makes several choices that a reasonable engineer would otherwise get wrong by instinct: refusals must be indistinguishable from one another, a Person may not span Schools, and a Student who leaves keeps a narrowed form of access rather than losing it entirely. Unless these are established in code first, every later feature will quietly re-decide them, differently, in each place.

## Solution

Build the identity and access foundation as a complete vertical slice, exercised through real HTTP requests against a real database.

A **User account** authenticates and nothing more. It carries no permissions and no academic data. Authenticating gives a caller a session; that session, when directed at a particular **School**, resolves to at most one **Person** in that School. All authorization flows from that Person's **School memberships**, each granting exactly one role.

Every request that is refused — because the record does not exist, because it belongs to another School, or because it exists and the actor may not read it — returns one identical response. The distinction between those cases is recorded in the **Audit record** and is never visible to the caller.

The slice delivers enough surface to prove all of this: authenticating, resolving the Persons a caller can reach, reading and listing Persons within a School, managing memberships and Guardian links, ending an **Enrollment**, and reading Audit records as a School Administrator. That is a small API, but it is the exact API on which every later feature depends, and it makes all three ADRs testable before there is anything else to get wrong.

## User Stories

### Authentication

1. As a person with credentials, I want to authenticate with SchoolGrid, so that I can access the Schools I have a relationship with.
2. As an authenticated caller, I want my session to identify me across requests, so that I do not re-authenticate for every action.
3. As an authenticated caller, I want to end my session explicitly, so that I can leave a shared device safely.
4. As a caller presenting wrong credentials, I want a response that does not reveal whether the account exists, so that the system cannot be used to enumerate accounts.
5. As a caller presenting an expired or unknown session, I want to be treated exactly as an unauthenticated caller, so that a stale session grants nothing.
6. As a School Administrator, I want every authentication attempt against my School's people recorded, so that I can investigate suspicious access.
7. As a User account holder with people at more than one School, I want one login that reaches all of them, so that I do not manage separate credentials per School.

### Resolving identity within a School

8. As an authenticated caller, I want to see which Schools my account can reach, so that I can choose the context I am acting in.
9. As an authenticated caller acting in a School, I want my request resolved to my Person in that School, so that my access reflects my relationships there and nowhere else.
10. As an authenticated caller with no Person in a School, I want my requests to that School refused exactly as an unauthenticated caller's would be, so that my account reveals nothing about Schools I do not belong to.
11. As a parent with children at two Schools, I want my two Person records kept entirely separate, so that a change at one School has no effect at the other.
12. As a School Administrator, I want a Person in my School to be a record only my School can see, so that no other School can read, reference, or discover them.

### Memberships and roles

13. As a School Administrator, I want to grant a Person a School membership with one role, so that their access matches their actual relationship to the School.
14. As a School Administrator, I want to grant one Person several memberships, so that a Faculty member whose own child attends can also be a Guardian.
15. As a School Administrator, I want to revoke one membership without affecting another held by the same Person, so that a teacher-parent who stops teaching keeps their Guardian access.
16. As a School Administrator, I want each membership to carry its own bounds, so that access begins and ends when the relationship does.
17. As a School Administrator, I want every grant and revocation recorded, so that I can reconstruct who could see what and when.
18. As a Faculty member, I want access to exactly the Class Offerings my Teaching assignments cover, so that I cannot reach rosters that are not mine.
19. As a Person whose every membership has ended, I want to retain no access to that School at all, so that departure is complete.

### Guardians

20. As a School Administrator, I want to link a Guardian to one specific Student, so that their access is scoped to that child alone.
21. As a School Administrator, I want to set an Access profile on each Guardian link, so that I can grant attendance read and results read independently.
22. As a Guardian of two Students, I want a separate link and profile for each, so that different children can have different arrangements.
23. As a Guardian, I want no access to any Student I am not linked to, so that my access cannot be widened by the School's structure.
24. As a School Administrator, I want to change or revoke a Guardian link, so that I can respond to a change in family circumstances.
25. As a Guardian of two Students where one leaves the School, I want my access to the remaining Student untouched, so that one child's departure does not cut me off from the other.

### Enrollment and its effect on access

26. As a School Administrator, I want to record a Student's Enrollment, so that they gain a Student's access to their own records.
27. As a School Administrator, I want to end a Student's Enrollment, so that their active participation stops.
28. As a Student whose Enrollment has ended, I want to keep reading my own published records, so that I can still reach my results after I leave.
29. As a Student whose Enrollment has ended, I want no access to anything unpublished, so that departure genuinely narrows what I can see.
30. As a Guardian of a Student whose Enrollment has ended, I want my link to that Student to end, so that my access does not outlive their time at the School.
31. As a returning Student, I want a new Enrollment to restore my full access, so that re-enrolling does not require an administrator to repair my account.
32. As a School Administrator, I want every prior Enrollment retained after a Student departs, so that their history stays intact.
33. As a School Administrator, I want a departing Student's records to remain with my School, so that nothing leaves with them.

### Safe denial

34. As any caller denied access, I want one response that does not reveal why, so that refusals cannot be used to learn what exists.
35. As a caller requesting a record in another School, I want the response identical to one for a record that does not exist, so that the School boundary leaks nothing.
36. As a caller requesting a record that exists but is forbidden to me, I want the response identical to one for a record that does not exist, so that being refused tells me nothing.
37. As a caller probing many identifiers, I want every refusal to look the same, so that no pattern in the responses distinguishes real records from invented ones.
38. As a School Administrator, I want the true reason for each refusal recorded, so that the information is preserved for investigation even though the caller never sees it.
39. As a caller listing records, I want records I may not read simply absent, so that a listing cannot be used to count what I cannot see.

### Platform administration

40. As a Platform Administrator, I want to create a School, so that a new School can begin using SchoolGrid.
41. As a Platform Administrator, I want to provision a School's first School Administrator, so that the School can manage itself from then on.
42. As a Platform Administrator, I want no access to any School-scoped record, so that operating the platform never means reading Student data.
43. As a Platform Administrator, I want no access to any School's Audit records, so that the boundary holds even for investigation.
44. As a School Administrator, I want platform-level actions against my School recorded in my Audit records, so that I can see what was done to my School from outside it.

### Audit

45. As a School Administrator, I want every sensitive change in my School recorded with actor, target, time, action, and reason, so that I can reconstruct what happened.
46. As a School Administrator, I want every refused access recorded, so that I can detect someone probing for records they should not reach.
47. As a School Administrator, I want every authentication event recorded, so that I can spot credential misuse.
48. As a School Administrator, I want configuration changes recorded, so that a change to the School's settings is never invisible.
49. As a School Administrator, I want Audit records that no one, including me, can alter or delete, so that the trail is trustworthy.
50. As a School Administrator, I want Audit records to outlive the Enrollment they describe, so that departure does not erase the history.
51. As a School Administrator, I want routine successful reads left unrecorded, so that the trail stays legible rather than drowning in ordinary traffic.
52. As a School Administrator, I want Audit records free of credentials and of Student data beyond what the entry needs, so that the trail is not itself a disclosure risk.
53. As a School Administrator, I want to read only my own School's Audit records, so that the boundary applies to the audit trail as much as to the records.

## Implementation Decisions

**Stack.** TypeScript throughout, with PostgreSQL as the store. Postgres is not incidental: the append-only Audit record and the transactional application of a change alongside its audit entry are enforced at the database level, not in application code.

**Modules.** Four, each with a narrow interface:

- **Authentication** — owns User accounts, credential verification, and sessions. It answers exactly one question for the rest of the system: which User account, if any, does this request belong to. It knows nothing about Schools, Persons, or roles.
- **Identity** — owns Schools, Persons, and the account-to-Person resolution. Given a User account and a School, it returns that account's Person in that School, or nothing.
- **Access** — owns School memberships, Guardian links, Access profiles, and Enrollment's effect on access. It is the sole authority on whether an actor may perform an action on a target, and it is the only module that answers that question.
- **Audit** — owns Audit records. It exposes an append operation and a School-scoped read, and no update or delete operation exists on its interface at all.

**Request context.** Every authorized request resolves to an actor context of School, Person, and that Person's active memberships, assembled once at the boundary and passed down. No module below the boundary re-derives it, and no module reads the raw session.

**Authorization is a single chokepoint.** Every School-scoped read and write passes through the Access module's decision. A handler may not consult a membership or role directly. This is what makes uniform Safe denial enforceable rather than aspirational: there is one place where a refusal is produced.

**Refusals are one response.** Every denial produces the same HTTP status, the same body, and no distinguishing headers. The internal reason — absent, cross-School, forbidden by role, forbidden by Access profile — travels only to the Audit module. Handlers cannot construct a refusal with a custom message; the refusal shape is produced in one place and is not parameterised by reason.

**Student access is derived, never stored.** Whether a Student has full or narrowed access is computed from whether an open Enrollment exists, not held as a flag on the membership. A returning Student's access widens because the derivation changes, so no repair step exists and no stored flag can drift.

**Schema.** School owns everything. Person carries a non-null School reference and a uniqueness constraint scoped to School; no table permits a row referencing two Schools. School membership is a separate row per role with its own bounds, so a Person may hold several. Guardian links are per-Student rows carrying the Access profile as two independent boolean permissions rather than an enum of three named modes. Enrollment rows are never deleted; ending one sets its end and leaves the row. Audit records are append-only, enforced by database privileges rather than by convention, with no update or delete grant on the table for the application role.

**Transactions.** Any sensitive mutation and its Audit record are written in one transaction. If the audit write fails, the mutation does not happen. This is a database-level guarantee and is tested as one.

**API contracts.** All School-scoped endpoints are addressed within a School, so the School is explicit on every request rather than inferred from the actor. Endpoints cover: authenticating and ending a session; listing the Schools an account reaches; reading and listing Persons within a School; granting, listing, and revoking memberships; creating, updating, and revoking Guardian links; recording and ending Enrollments; and reading Audit records. Listings omit records the actor may not read rather than returning them redacted or returning a partial-access indicator.

**Access profile enforcement is deferred, storage is not.** The two permissions are stored, validated, and returned by this slice, but there is nothing yet to read with them. Enforcement arrives with the Attendance and Term result slices. The profile is modelled now so those slices do not have to re-open the question.

## Testing Decisions

**What makes a good test here.** A test issues a real HTTP request as a real authenticated actor and asserts on the response the actor receives. It never reaches into a module to check that a function was called, never asserts on the shape of an internal decision object, and never inspects a role directly. The one exception is Audit records, which are asserted through the Audit module's own read endpoint as a School Administrator — reading them as an actor is the behavior, not an implementation detail.

**One seam: the HTTP request boundary.** Every test in this slice goes through it. This is a deliberate choice rather than a default, because ADR-0002's guarantee is precisely that two refusals are *indistinguishable to the caller*, and that is only assertable where the caller stands. A test below HTTP can confirm that a denial occurred; it cannot confirm that a cross-School denial and an absent-record denial look the same. A shared test helper authenticates an account and returns a client bound to a School, so that setting up an actor is one line and no test is tempted to bypass the boundary for convenience.

**A real Postgres, isolated per test run.** The append-only Audit table and the mutation-plus-audit transaction are database guarantees, and a fake cannot verify either. Tests that matter here include: attempting to update an Audit record and being refused by the database; forcing an audit write to fail and confirming the mutation rolled back with it.

**Modules under test.** All four, but only through the boundary. Authentication is exercised by logging in and using sessions; Identity by resolving accounts to Persons across Schools; Access by every authorized and refused request in the suite; Audit by reading the trail back and by attempting to tamper with it.

**The tests that carry the most weight.** A denial-equivalence suite asserting that a request for an absent record, a cross-School record, and a forbidden record produce byte-identical responses — this is the test that would catch a well-meaning future change to error messages. A School-isolation suite attempting every endpoint against another School's identifiers. A membership-independence suite proving that revoking one role leaves another intact. An enrollment-lifecycle suite walking a Student through enrollment, departure, narrowed access, and return.

**Prior art.** None — this is the first code in the repo, so this slice sets the pattern. The test helpers it establishes, particularly the authenticated School-bound client and the per-run database setup, are the prior art every later slice should follow rather than reinvent.

## Out of Scope

Everything in the academic structure and academic records sections of the glossary: Academic Year, Term, Course, Class Offering, Course sequence, Roster membership, Teaching assignment, Instructional day, Attendance and its session, snapshot and window, Result value scale, Term result, Publication, and Correction request. These depend on this slice and follow it.

Also out of scope: enforcing the Access profile, which is stored here but has nothing to gate until Attendance and results exist; School configuration beyond what identity needs, since timezone, Instructional days, the Attendance window and the Result value scale belong to the slices that use them; password reset, account recovery, and multi-factor authentication; any user interface, as this slice is exercised through HTTP alone; bulk import of Persons or Enrollments; and transcript export, district rollups, or any cross-School capability, all of which ADR-0001 rules out by design.

## Further Notes

Three ADRs govern this slice directly and should be read before implementing it: ADR-0001 establishes that no domain object spans Schools, ADR-0002 establishes uniform Safe denial, and ADR-0003 establishes publication semantics — the last mattering here only because the narrowed access a departed Student retains is defined in terms of published records.

Two things are likely to be "fixed" by a future contributor who has not read the ADRs, and both should be commented at the point of implementation rather than left to be rediscovered. The first is the uniform refusal, which will read as unhelpful error handling. The second is the omission of successful reads from the audit trail, which will read as an oversight; it is a deliberate choice to keep probing visible against a quiet background.

One asymmetry is worth stating plainly because it looks arbitrary in isolation: when an Enrollment ends, the Student keeps narrowed access to their own published records while every linked Guardian loses access entirely. The reasoning is that a departed Student still needs their own transcript, whereas a Guardian's standing derives from an active relationship to the School. This was decided deliberately and did not meet the bar for an ADR, so it is recorded here instead.
