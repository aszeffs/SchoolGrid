-- Trial visitors (CONTEXT.md: Trial visitor, ADR-0013): someone who proved an
-- outside identity, a GitHub or Google sign-in, to start a Trial School. Not a
-- User account and not a Person. Only a keyed hash of the provider and its
-- subject identifier is kept, so these rows name no one even to a reader of
-- the database, and a visitor is forgotten once no Trial School of theirs
-- remains.
CREATE TABLE app.trial_visitor (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC-SHA256 of `provider:subject`, keyed by TRIAL_IDENTITY_KEY.
  identity    bytea NOT NULL UNIQUE CONSTRAINT trial_visitor_identity_length CHECK (octet_length(identity) = 32),
  created_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON app.trial_visitor TO schoolgrid_app;
GRANT INSERT (identity) ON app.trial_visitor TO schoolgrid_app;

-- The Trial visitor who started a Trial School. Like its expiry, written once
-- when the School is created: the application holds no UPDATE on it.
ALTER TABLE app.school ADD COLUMN trial_visitor_id uuid REFERENCES app.trial_visitor (id);
ALTER TABLE app.school
  ADD CONSTRAINT school_trial_visitor_only_on_trials CHECK (trial_visitor_id IS NULL OR trial_expires_at IS NOT NULL);

CREATE INDEX school_trial_visitor_idx ON app.school (trial_visitor_id) WHERE trial_visitor_id IS NOT NULL;

-- Deleting an expired Trial School now also forgets its Trial visitor, once no
-- other School of theirs remains.
CREATE OR REPLACE FUNCTION app.delete_expired_trial_school(target uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  expires_at timestamptz;
  visitor uuid;
BEGIN
  -- Locked, so a sweep running alongside waits here and then finds it gone.
  SELECT trial_expires_at, trial_visitor_id INTO expires_at, visitor FROM app.school WHERE id = target FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF expires_at IS NULL OR expires_at > now() THEN
    RAISE EXCEPTION 'only a Trial School past its expiry may be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM app.term_result WHERE school_id = target;
  DELETE FROM app.publication WHERE school_id = target;
  DELETE FROM app.correction_request WHERE school_id = target;
  DELETE FROM app.attendance WHERE school_id = target;
  DELETE FROM app.roster_snapshot_member WHERE school_id = target;
  DELETE FROM app.attendance_session WHERE school_id = target;
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
  DELETE FROM app.result_value WHERE school_id = target;
  DELETE FROM app.result_value_scale_version WHERE school_id = target;
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
  DELETE FROM app.trial_visitor
  WHERE id = visitor AND NOT EXISTS (SELECT 1 FROM app.school WHERE trial_visitor_id = visitor);
  RETURN true;
END
$$;
