-- Trial Schools (CONTEXT.md: Trial School, ADR-0012): a School a visitor
-- starts for themselves, of invented data, which lives two hours and is then
-- deleted whole.

-- A School is a Trial School when it has an expiry, and a real one when it has
-- none. The application sets it when it creates the School, and cannot change
-- it afterwards: the grants of migrations/0012 still let it update a School's
-- timezone alone, so no real School can be made a trial, and no trial's life
-- can be extended.
ALTER TABLE app.school ADD COLUMN trial_expires_at timestamptz;

CREATE INDEX school_trial_expires_at_idx ON app.school (trial_expires_at) WHERE trial_expires_at IS NOT NULL;

-- Where a User account was created, when it was created inside a School: by
-- redeeming an Invitation there, or as one of a Trial School's role accounts.
-- It is what a Trial School's deletion takes with it, and what stops a
-- Session being live once that School has expired.
--
-- A role account is the one account a Trial School holds for a School role,
-- which the visitor acts as by the trial issuing a Session for it. It has no
-- password, and can never be given one: the check below holds that, and the
-- application may not clear the role to get past it.
ALTER TABLE app.user_account
  ADD COLUMN created_in_school_id uuid REFERENCES app.school (id),
  ADD COLUMN trial_role text CHECK (trial_role IN ('school_administrator', 'faculty', 'student', 'guardian')),
  ALTER COLUMN password_hash DROP NOT NULL,
  -- An account with no password hash is one no password verifies: a role
  -- account's, and no other's.
  ADD CONSTRAINT user_account_password_check CHECK ((password_hash IS NULL) = (trial_role IS NOT NULL));

CREATE UNIQUE INDEX user_account_trial_role_key
  ON app.user_account (created_in_school_id, trial_role) WHERE trial_role IS NOT NULL;

-- The application creates accounts, and changes what a password or username
-- is. Where an account was created, and whether it is a role account, are
-- written once, when it is created.
REVOKE UPDATE ON app.user_account FROM schoolgrid_app;
GRANT UPDATE (username, password_hash) ON app.user_account TO schoolgrid_app;

-- Audit records stay append-only, but for one exception: the deletion of a
-- whole expired Trial School takes its Audit records with it. The backstop
-- trigger lets exactly that through, for any role; the application holds no
-- DELETE on them at all, and reaches that deletion only through the function
-- below.
CREATE OR REPLACE FUNCTION app.refuse_audit_record_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM app.school WHERE id = OLD.school_id AND trial_expires_at <= now()
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit records are append-only: % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Deletes one Trial School past its expiry, with everything in it: its
-- Persons and every record about them, its Audit records, and the User
-- accounts created in it. Refuses any other School, a real one or a trial
-- still live, so a real School can never be deleted through it. False when
-- there is no such School, as when another sweep deleted it first.
--
-- The only way the application deletes a School or an Audit record. It runs
-- as the schema owner, who alone may; the application may only call it.
CREATE FUNCTION app.delete_expired_trial_school(target uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  expires_at timestamptz;
BEGIN
  -- Locked, so a sweep running alongside waits here and then finds it gone.
  SELECT trial_expires_at INTO expires_at FROM app.school WHERE id = target FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF expires_at IS NULL OR expires_at > now() THEN
    RAISE EXCEPTION 'only a Trial School past its expiry may be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM app.roster_membership WHERE school_id = target;
  DELETE FROM app.teaching_assignment WHERE school_id = target;
  DELETE FROM app.class_offering WHERE school_id = target;
  DELETE FROM app.course WHERE school_id = target;
  DELETE FROM app.instructional_day_exception WHERE school_id = target;
  DELETE FROM app.term WHERE school_id = target;
  DELETE FROM app.academic_year WHERE school_id = target;
  DELETE FROM app.invitation WHERE school_id = target;
  DELETE FROM app.enrollment WHERE school_id = target;
  DELETE FROM app.guardian_link WHERE school_id = target;
  DELETE FROM app.school_membership WHERE school_id = target;
  DELETE FROM app.audit_record WHERE school_id = target;
  DELETE FROM app.person WHERE school_id = target;

  -- An account created here that has since gone on to another School belongs
  -- to that School's records too, so it stays, no longer counted as this
  -- one's. Every other is deleted, and its Sessions with it.
  DELETE FROM app.user_account account
  WHERE account.created_in_school_id = target
    AND NOT EXISTS (SELECT 1 FROM app.person WHERE user_account_id = account.id)
    AND NOT EXISTS (SELECT 1 FROM app.invitation WHERE redeemed_by_user_account_id = account.id)
    AND NOT EXISTS (SELECT 1 FROM app.platform_administrator WHERE user_account_id = account.id);
  UPDATE app.user_account SET created_in_school_id = NULL WHERE created_in_school_id = target;

  DELETE FROM app.school WHERE id = target;
  RETURN true;
END
$$;

-- Deletes every Trial School past its expiry, and says how many. What a trial
-- start runs first, and what the daily scheduled sweep runs.
CREATE FUNCTION app.delete_expired_trial_schools() RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
RETURN (
  SELECT count(*) FILTER (WHERE app.delete_expired_trial_school(id))::integer
  FROM app.school
  WHERE trial_expires_at <= now()
);

-- A function may be called by anyone unless that is taken away.
REVOKE ALL ON FUNCTION app.delete_expired_trial_school(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_expired_trial_schools() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_trial_school(uuid) TO schoolgrid_app;
GRANT EXECUTE ON FUNCTION app.delete_expired_trial_schools() TO schoolgrid_app;
