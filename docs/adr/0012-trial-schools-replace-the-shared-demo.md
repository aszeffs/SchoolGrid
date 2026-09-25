# Trial Schools replace the shared demo

The public site used to publish one sign-in per School role for a single invented School, reset nightly. Every visitor acted as the same Persons and saw what strangers had typed, and the site looked like a service it was not. We replace it with Trial Schools: "Start a trial" provisions a private School of invented data for one visitor, who switches between roles inside it, and which is deleted two hours later. The public deployment holds Trial Schools only, and says plainly that it hosts no real School.

A visitor acts as a role through a Session the trial issues for that role's User account, which has no usable password. Nothing is published, so there is nothing to leak, and authorization runs through ordinary Sessions and School memberships with no trial special case. We rejected generating passwords and showing them once: it adds friction and creates credentials that outlive the visitor's attention.

Expiry is enforced when a Session is checked, so access ends on the minute. Deletion is lazy: expired Trial Schools are deleted when a new trial starts, and a daily scheduled run is the backstop. Deleting a Trial School deletes everything in it, Audit records and the User accounts created in it included. That is the one exception to Audit records being append-only, and it is fenced in the database, not in the application: an owner-defined `SECURITY DEFINER` function deletes only Schools marked as trials and past their expiry, and the application role is granted `EXECUTE` on it and no delete on Schools or Audit records. We rejected granting the application role `DELETE`: a compromised service could then erase any audit trail.

## Consequences

- The invented data is built by application code in one transaction, through the same domain operations the app uses, and ships in the image. It holds no credentials, so the image check that forbade the demo's published sign-ins becomes a check that no published credentials ship. `demo/seed.sql`, the nightly reset workflow and the `.gitleaks.toml` exception are removed.
- `TRIALS_ENABLED` replaces `DEMO_MODE` and is off by default: a self-hosted deployment offers no trials.
- Trials are capped: at most 30 live, and 2 started per IP per hour, both configuration values. The global cap is the hard bound on the free database tier; the per-IP limit is counted per instance and is only a first line.
- A Trial School takes the visitor's browser timezone, checked against `app.timezone` and falling back to UTC, so its Academic Year sits around the visitor's own today.
- Invitations work inside a Trial School. A User account an Invitation creates there is deleted with it.
