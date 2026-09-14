-- Every role a Person can hold in a School, and the bounds each membership
-- carries. A membership is still one row per role, so a Faculty member whose
-- own child attends holds two rows that have nothing to do with each other.

ALTER TABLE app.school_membership DROP CONSTRAINT school_membership_role_check;
ALTER TABLE app.school_membership ADD CONSTRAINT school_membership_role_check
  CHECK (role IN ('school_administrator', 'faculty', 'student', 'guardian'));

-- A membership grants access from its start until its end, and not outside
-- them. An open end is a relationship with no end yet. An end equal to the
-- start is a membership revoked before it began: it never granted anything.
ALTER TABLE app.school_membership
  ADD COLUMN starts_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ends_at   timestamptz;

UPDATE app.school_membership SET starts_at = created_at;

ALTER TABLE app.school_membership ADD CONSTRAINT school_membership_bounds_check
  CHECK (ends_at IS NULL OR ends_at >= starts_at);

-- The target of composite references from later School-scoped rows.
ALTER TABLE app.school_membership ADD CONSTRAINT school_membership_school_id_id_key
  UNIQUE (school_id, id);

-- A membership is a record of who could see what and when, so it is never
-- deleted and never rewritten: revoking or narrowing one moves its end, and
-- nothing else about it can change. The grant enforces that for the
-- application, as it does for Audit records.
REVOKE UPDATE, DELETE ON app.school_membership FROM schoolgrid_app;
GRANT UPDATE (ends_at) ON app.school_membership TO schoolgrid_app;
