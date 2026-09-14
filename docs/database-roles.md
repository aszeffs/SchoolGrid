# Database roles

SchoolGrid connects to Postgres with two separate logins, and never uses one in place of the other.

| Variable | Role | Used for |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | The schema owner | Applying migrations at startup (or with `npm run migrate`). The connection is closed before the service answers any request. |
| `DATABASE_URL` | A login that is a member of `schoolgrid_app` and nothing else | Every request the service serves. |

## Why two

Audit records are append-only, and the database enforces it: `schoolgrid_app` has `SELECT` and a column-limited `INSERT` on `app.audit_record`, and no `UPDATE`, `DELETE`, or `TRUNCATE`. Grants do not bind a table's owner or a superuser, though. If the service ran as the owner, the guarantee would be switched off without anything saying so.

So the service checks its own role when it starts. If `DATABASE_URL` could alter an Audit record, the process logs why and exits. Setting both variables to the same owner login gives a service that will not start, rather than one that runs without the guarantee.

A trigger also rejects updates, deletes and truncates on the table for every role, the owner included. That stops accidents, such as a migration or a manual fix, but it is not the main defence: a superuser can disable a trigger.

## Setting up a database

Roles belong to the Postgres cluster, not to one database. Create them once, as a user allowed to create roles, before the service first starts:

```sql
CREATE ROLE schoolgrid_app NOLOGIN;
CREATE ROLE schoolgrid_runtime LOGIN PASSWORD '<a generated secret>' IN ROLE schoolgrid_app;
```

If `schoolgrid_app` does not exist yet, migration `0004` creates it. It is created ahead of time here only so the login can be made a member of it.

Then point the service at both roles:

```bash
MIGRATION_DATABASE_URL=postgres://<owner>:<password>@<host>:5432/schoolgrid
DATABASE_URL=postgres://schoolgrid_runtime:<password>@<host>:5432/schoolgrid
```

## Adding a table

Nothing grants privileges by default. A migration that creates a table must grant `schoolgrid_app` exactly what the service needs on it. If it forgets, the service gets `permission denied`: the tests fail, because they run as this role too, and the service is never quietly given more access than it should have. Only an append-only table should be granted `SELECT, INSERT` alone.
