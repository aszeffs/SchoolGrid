# Per-Student publication semantics

Publication is an irreversible fact about one Student's Term result, reached through an act performed on a Class Offering. Publishing an offering publishes every result carrying a value at that moment; a result created afterwards is published by a later act, without reversing or re-asserting what is already visible. We chose this over a strictly offering-wide, once-only transition because that version stranded two real cases: a Student joining the roster after publication could never have a result published at all, and a Student who withdrew mid-Term was excluded from the completeness check and so never saw their partial result.

## Consequences

- The completeness check still runs against active roster members only, so a withdrawal cannot block an offering's publication.
- Publication may occur more than once for an offering, but never re-publishes or revokes an already-published result.
- Attendance and Publication deliberately use different notions of a roster: Attendance works against the captured Roster snapshot, Publication against active Roster memberships. They are not interchangeable.
