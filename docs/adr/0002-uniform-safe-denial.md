# Uniform Safe denial

Every refused access produces one identical response, whether the record is absent, belongs to another School, or exists but is forbidden to this actor. The reason is written only to the Audit record. We rejected the friendlier two-tier alternative — "not found" for unknown records, a distinct refusal for known-but-forbidden ones — because any observable difference lets an actor confirm a record exists, which is the exact leak the rule exists to prevent.

## Consequences

- A Guardian on attendance-only probing for results sees precisely what a stranger from another School sees.
- Error messages cannot explain why access failed, so support questions route through a School Administrator reading the Audit record.
- This will look like poor UX to a future reader. It is deliberate; do not "improve" it by distinguishing the cases.

## Addendum: what "identical" covers

Indistinguishable means that nothing in a refusal may depend on what exists: records, accounts, Schools, or routes. A response may still differ on properties of the caller's own request, because it reveals only what the caller already sent.

- **Throttling is not a refusal.** A client over the rate limit gets `429` with `Retry-After`, not the refusal. The limit is decided from request volume per client address, before routing reaches any record, so it cannot reflect what exists, while collapsing it into the refusal would deny honest clients the signal to back off. For the same reason, the counter headers that change on every request are never sent.
- **An oversized body may close the connection.** A sign-in body over the server's size limit gets the one refusal status and body, but keeps `connection: close`: the unread body cannot be left on the socket for the next request to be parsed from. The header discloses only that the caller's own body was too large.

Anything that varies with the target of a request still falls under the rule above. This addendum does not license a distinct response for any case the ADR collapses.
