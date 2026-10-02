-- Term results (CONTEXT.md: Term result): one per Student and Class Offering,
-- since a Class Offering belongs to one Term.
--
-- A result begins as a draft. Its value, score and comment are each optional
-- until it is published. Its value is one of a Result value scale version's
-- values, so the version it was bound to is the version that value belongs
-- to; a save of the scale never changes it. It names who last recorded it and
-- when, which is why a first draft needs no Audit record of its own.
CREATE TABLE app.term_result (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id              uuid NOT NULL,
  student_person_id      uuid NOT NULL,
  class_offering_id      uuid NOT NULL,
  result_value_id        uuid,
  score                  numeric(4, 1) CONSTRAINT term_result_score_bounds CHECK (score BETWEEN 0 AND 100),
  comment                text CONSTRAINT term_result_comment_bounds CHECK (
    btrim(comment) <> '' AND char_length(comment) <= 500
  ),
  recorded_by_person_id  uuid NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  -- Everything it names belongs to the result's own School (ADR-0001).
  CONSTRAINT term_result_class_offering_fk
    FOREIGN KEY (school_id, class_offering_id) REFERENCES app.class_offering (school_id, id),
  FOREIGN KEY (school_id, student_person_id) REFERENCES app.person (school_id, id),
  FOREIGN KEY (school_id, result_value_id) REFERENCES app.result_value (school_id, id),
  FOREIGN KEY (school_id, recorded_by_person_id) REFERENCES app.person (school_id, id),
  CONSTRAINT term_result_one_per_offering UNIQUE (school_id, class_offering_id, student_person_id),
  UNIQUE (school_id, id)
);

-- Reading one Student's results.
CREATE INDEX term_result_student ON app.term_result (school_id, student_person_id);

-- A draft is changed, never removed. Which Student and offering a result is
-- for never changes; its content, and who set it when, do.
GRANT SELECT ON app.term_result TO schoolgrid_app;
GRANT INSERT (school_id, student_person_id, class_offering_id, result_value_id, score, comment, recorded_by_person_id)
  ON app.term_result TO schoolgrid_app;
GRANT UPDATE (result_value_id, score, comment, recorded_by_person_id, recorded_at) ON app.term_result TO schoolgrid_app;

-- An expired Trial School is deleted whole (migrations/0018), its Term
-- results with it: the one way any is deleted.
CREATE OR REPLACE FUNCTION app.delete_expired_trial_school(target uuid) RETURNS boolean
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

  DELETE FROM app.term_result WHERE school_id = target;
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
  RETURN true;
END
$$;
