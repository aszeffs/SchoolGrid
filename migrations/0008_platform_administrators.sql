-- A Platform Administrator operates the platform itself: creating Schools and
-- provisioning each one's first School Administrator. It is not a Person, and
-- belongs to no School, so it lives beside Schools rather than inside one.
--
-- A User account still holds no authorization. Being a Platform Administrator
-- is this row, just as holding a School role is a membership row, and the
-- account merely resolves to it.
CREATE TABLE app.platform_administrator (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id  uuid NOT NULL UNIQUE REFERENCES app.user_account (id),
  display_name     text NOT NULL CHECK (display_name <> ''),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The application may only look a Platform Administrator up. Making one is an
-- act on the platform from outside the running service, like creating the
-- database roles (docs/database-roles.md), so no request can make its caller,
-- or anyone else, a Platform Administrator.
GRANT SELECT ON app.platform_administrator TO schoolgrid_app;

-- What a Platform Administrator does to a School is recorded in that School's
-- own trail, so its School Administrator can see what was done to it from
-- outside. The actor is named here rather than as a Person, since a Platform
-- Administrator is none, and never as both. The reference also keeps a
-- Platform Administrator who ever acted on a School from being deleted: the
-- trail outlives them.
ALTER TABLE app.audit_record
  ADD COLUMN actor_platform_administrator_id uuid REFERENCES app.platform_administrator (id),
  ADD CONSTRAINT audit_record_one_actor_check
    CHECK (actor_person_id IS NULL OR actor_platform_administrator_id IS NULL);

GRANT INSERT (actor_platform_administrator_id) ON app.audit_record TO schoolgrid_app;
