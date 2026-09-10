# Uniform Safe denial

Every refused access produces one identical response, whether the record is absent, belongs to another School, or exists but is forbidden to this actor. The reason is written only to the Audit record. We rejected the friendlier two-tier alternative — "not found" for unknown records, a distinct refusal for known-but-forbidden ones — because any observable difference lets an actor confirm a record exists, which is the exact leak the rule exists to prevent.

## Consequences

- A Guardian on attendance-only probing for results sees precisely what a stranger from another School sees.
- Error messages cannot explain why access failed, so support questions route through a School Administrator reading the Audit record.
- This will look like poor UX to a future reader. It is deliberate; do not "improve" it by distinguishing the cases.
