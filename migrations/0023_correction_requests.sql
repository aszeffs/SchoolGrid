-- Correction requests (CONTEXT.md: Correction request): a proposed change to
-- a record that a School Administrator approves or rejects, or its requester
-- withdraws.
--
-- A request names its kind of target, so Term results can reuse the table
-- later; Attendance is the only kind for now, and its target is one Student's
-- Attendance for one Class Offering on one School date. The before value is
-- the target's at the moment the request was raised, null when none was
-- recorded; approval is refused while the target's current value differs.
CREATE TABLE app.correction_request (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id               uuid NOT NULL,
  target_kind             text NOT NULL CONSTRAINT correction_request_kind_known CHECK (target_kind IN ('attendance')),
  student_person_id       uuid NOT NULL,
  class_offering_id       uuid NOT NULL,
  date                    date NOT NULL,
  before_value            text,
  after_value             text NOT NULL,
  reason                  text NOT NULL CONSTRAINT correction_request_reason_given CHECK (btrim(reason) <> ''),
  requested_by_person_id  uuid NOT NULL,
  raised_at               timestamptz NOT NULL DEFAULT now(),
  state                   text NOT NULL DEFAULT 'pending' CONSTRAINT correction_request_state_known CHECK (
    state IN ('pending', 'approved', 'rejected', 'withdrawn')
  ),
  -- Who approved or rejected it; for a withdrawn request, its requester.
  decided_by_person_id    uuid,
  decided_at              timestamptz,
  rejection_reason        text,
  self_approved           boolean NOT NULL DEFAULT false,
  CONSTRAINT correction_request_attendance_values CHECK (
    target_kind <> 'attendance' OR (
      after_value IN ('present', 'tardy', 'excused_absence', 'unexcused_absence', 'absent_pending_review')
      AND (before_value IS NULL
        OR before_value IN ('present', 'tardy', 'excused_absence', 'unexcused_absence', 'absent_pending_review'))
    )
  ),
  CONSTRAINT correction_request_changes_something CHECK (before_value IS DISTINCT FROM after_value),
  -- A request is decided exactly when it has left Pending.
  CONSTRAINT correction_request_decided_when_not_pending CHECK (
    (state = 'pending') = (decided_by_person_id IS NULL) AND (state = 'pending') = (decided_at IS NULL)
  ),
  CONSTRAINT correction_request_withdrawn_by_requester CHECK (
    state <> 'withdrawn' OR decided_by_person_id = requested_by_person_id
  ),
  -- Only a rejection carries a reason of its own, and it always does.
  CONSTRAINT correction_request_rejected_with_reason CHECK (
    (state = 'rejected') = (rejection_reason IS NOT NULL) AND btrim(coalesce(rejection_reason, 'x')) <> ''
  ),
  CONSTRAINT correction_request_self_approval_is_approval CHECK (
    NOT self_approved OR (state = 'approved' AND decided_by_person_id = requested_by_person_id)
  ),
  -- Every record it names belongs to its own School (ADR-0001).
  FOREIGN KEY (school_id, student_person_id) REFERENCES app.person (school_id, id),
  FOREIGN KEY (school_id, class_offering_id) REFERENCES app.class_offering (school_id, id),
  FOREIGN KEY (school_id, requested_by_person_id) REFERENCES app.person (school_id, id),
  FOREIGN KEY (school_id, decided_by_person_id) REFERENCES app.person (school_id, id),
  UNIQUE (school_id, id)
);

-- Listing a School's requests, and one requester's.
CREATE INDEX correction_request_school ON app.correction_request (school_id, raised_at);
CREATE INDEX correction_request_requester ON app.correction_request (school_id, requested_by_person_id);

-- A request is never deleted by the application, nor is what it proposes
-- changed: only its state, and who decided it when.
GRANT SELECT ON app.correction_request TO schoolgrid_app;
GRANT INSERT (school_id, target_kind, student_person_id, class_offering_id, date, before_value, after_value,
              reason, requested_by_person_id)
  ON app.correction_request TO schoolgrid_app;
GRANT UPDATE (state, decided_by_person_id, decided_at, rejection_reason, self_approved)
  ON app.correction_request TO schoolgrid_app;

-- An expired Trial School is deleted whole (migrations/0018), its Correction
-- requests with it: the one way any of them is deleted.
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
