-- The application's database role, and the Audit record it can append to but
-- never change.
--
-- Migrations run as the schema owner. The running application logs in as a
-- separate role that is a member of `schoolgrid_app` and holds nothing else, so
-- what it may do is exactly what is granted below. That is what makes the
-- append-only guarantee a database fact rather than an application convention:
-- an owner or superuser ignores table grants, so the application must be
-- neither. See docs/database-roles.md.
--
-- Nothing here uses ALTER DEFAULT PRIVILEGES. Every later migration grants on
-- the tables it creates, explicitly, so a table whose grants were forgotten
-- fails closed — the application is refused — rather than silently receiving
-- UPDATE and DELETE it was never meant to have.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'schoolgrid_app') THEN
    CREATE ROLE schoolgrid_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA app TO schoolgrid_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.user_account,
  app.user_session,
  app.school,
  app.person,
  app.school_membership
TO schoolgrid_app;

-- Whether a before or after value is fit to be written down forever: a flat
-- object of scalars, with no key that names a credential. Nesting is refused so
-- that nothing can be tucked beneath an innocuous key. The key test is a
-- backstop, not the design: an entry should name what changed by identifier,
-- and never carry a secret or a Student's data beyond what the entry needs.
CREATE FUNCTION app.is_fit_audit_value(value jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  RETURN value IS NULL OR (
    jsonb_typeof(value) = 'object'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(value) AS entry (key, item)
      WHERE jsonb_typeof(item) IN ('object', 'array')
         OR entry.key ~* '(password|passphrase|secret|token|credential|hash)'
    )
  );

CREATE TABLE app.audit_record (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order records were appended in. Records written in one transaction
  -- share a timestamp, so time alone cannot order them.
  position        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  school_id       uuid NOT NULL REFERENCES app.school (id),
  -- Null when no Person acted: an unauthenticated caller, or the platform.
  actor_person_id uuid,
  action          text NOT NULL CHECK (action <> '' AND char_length(action) <= 100),
  target_type     text NOT NULL CHECK (target_type <> '' AND char_length(target_type) <= 100),
  -- Text rather than uuid: a refused request may name an identifier that could
  -- never exist, and that is exactly what an investigation needs to see.
  target_id       text CHECK (char_length(target_id) <= 256),
  reason          text CHECK (char_length(reason) <= 1000),
  before_value    jsonb CHECK (app.is_fit_audit_value(before_value)),
  after_value     jsonb CHECK (app.is_fit_audit_value(after_value)),
  -- Set by the database, and not insertable by the application (see the grant
  -- below), so a record cannot be back- or forward-dated.
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, actor_person_id) REFERENCES app.person (school_id, id)
);

CREATE INDEX audit_record_school_idx ON app.audit_record (school_id, position);

-- The guarantee: the application may read and append, and nothing more. No
-- UPDATE, DELETE, or TRUNCATE, and INSERT only on the columns an entry supplies.
GRANT SELECT ON app.audit_record TO schoolgrid_app;
GRANT INSERT (
  school_id, actor_person_id, action, target_type, target_id, reason, before_value, after_value
) ON app.audit_record TO schoolgrid_app;

-- A backstop for the roles the grants cannot bind: the owner and whoever runs
-- migrations. A superuser can still disable this, which is why the application
-- must never be one; this exists to stop an accident, not an administrator.
CREATE FUNCTION app.refuse_audit_record_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only: % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_record_append_only
  BEFORE UPDATE OR DELETE ON app.audit_record
  FOR EACH ROW EXECUTE FUNCTION app.refuse_audit_record_change();

CREATE TRIGGER audit_record_no_truncate
  BEFORE TRUNCATE ON app.audit_record
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_audit_record_change();
