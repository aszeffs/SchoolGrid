# The session response carries the actor's facts, not their permissions

`GET /api/session` returns the account together with each School the account reaches, the Person it resolves to in that School, and the roles that Person holds. It does not return permission flags or capability booleans. The web app needs to name the signed-in Person, show the right School, and render navigation that is correct on first paint; it previously had none of that, and inferred whether the caller administered a School by checking whether a listed Person carried a `claimed` field. We rejected returning computed capabilities such as `canManagePersons`, which would be easier for the UI and would put a second copy of the authorization rules in the client, free to drift from the one on the server. Facts about the actor are already the actor's to know; decisions about access stay where they are enforced.

## Consequences

- The web app sometimes offers an action that is then refused, and sometimes hides one it could have offered. That is accepted. Roles are a good enough guide for navigation, and the server is the only thing that decides.
- A refused action still shows the one refusal, identical to every other (ADR-0002). The session response makes the UI better informed, never more talkative.
- The response names only the calling actor. It is not a directory: no other Person's roles, and no School the account does not reach, appear in it.
- Deriving the same thing client-side from `/schools` and a per-School memberships call was rejected: N+1 requests before the shell can paint, and a flash of empty navigation on every load.
- When authorization grows a dimension the roles alone do not capture, the answer is a route that decides it, not a flag added here.
- One fact beyond the roles is here: how many Class Offerings the Person was ever assigned to teach. What they taught outlasts their Faculty membership, so a Person who now holds only another role still has classes to reach, and the roles alone cannot lead them there. It is a count of the actor's own records, not a decision: the route listing them still decides who may.
