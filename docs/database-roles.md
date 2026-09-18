# Database roles

SchoolGrid connects to Postgres with two separate logins, and never uses one in place of the other.

| Variable | Role | Used for |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | The schema owner | Applying migrations at startup (or with `npm run migrate`). The connection is closed before the service answers any request. Optional for the service; see below. |
| `DATABASE_URL` | A login that is a member of `schoolgrid_app` and nothing else | Every request the service serves. |

## When the service needs the owner's credentials

Only when it is expected to migrate the database itself.

- **Set `MIGRATION_DATABASE_URL`** for local development and the container smoke test. The service applies any pending migrations as the owner, closes that connection, then serves as `DATABASE_URL`.
- **Leave it unset** wherever the service should hold nothing but the application's role, as in production. The service does not migrate. It reads the record of applied migrations as `DATABASE_URL` and checks that every migration in the image is recorded with a matching checksum. If one is missing, it logs which and exits non-zero. Migrate first, as the owner, with `npm run migrate` or `node dist/db/migrate-cli.js` from the image.

Refusing to start is deliberate. A service that could "just migrate" would have to hold credentials that grants do not bind, which is what the rest of this page exists to prevent.

`schoolgrid_app` can read `public.schema_migrations` (migration `0011`) and nothing more: the record decides whether the service starts, so the role it checks must not be able to rewrite it.

## Why two

Audit records are append-only, and the database enforces it: `schoolgrid_app` has `SELECT` and a column-limited `INSERT` on `app.audit_record`, and no `UPDATE`, `DELETE`, or `TRUNCATE`. Grants do not bind a table's owner or a superuser, though. If the service ran as the owner, the guarantee would be switched off without anything saying so.

So the service checks its own role when it starts. If `DATABASE_URL` could alter an Audit record, the process logs why and exits. Setting both variables to the same owner login gives a service that will not start, rather than one that runs without the guarantee.

A trigger also rejects updates, deletes and truncates on the table for every role, the owner included. That stops accidents, such as a migration or a manual fix, but it is not the main defence: a superuser can disable a trigger.

## Setting up a database

The server must be PostgreSQL 18 or newer. Migration `0009` normalises usernames with `casefold()` and the builtin `pg_unicode_fast` collation, both new in 18. Against an older server, `migrate` refuses before applying anything and names the version it found.

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

## Making a Platform Administrator

A Platform Administrator creates Schools and provisions each School's first School Administrator, through `POST /api/platform/schools`. No request can make one, because `schoolgrid_app` can only read `app.platform_administrator`. Make one as the schema owner, for an existing User account:

```sql
INSERT INTO app.platform_administrator (user_account_id, display_name)
SELECT id, 'Platform Operations' FROM app.user_account WHERE app.username_key(username) = app.username_key('<username>');
```

Use an account that holds no Person in any School. A Platform Administrator is refused by every School-scoped endpoint, even through a Person their account resolves to.

## Adding a table

Nothing grants privileges by default. A migration that creates a table must grant `schoolgrid_app` exactly what the service needs on it. If it forgets, the service gets `permission denied`: the tests fail, because they run as this role too, and the service is never quietly given more access than it should have. Only an append-only table should be granted `SELECT, INSERT` alone.
