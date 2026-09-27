-- Attendance (CONTEXT.md: Attendance), taken through Attendance sessions
-- (CONTEXT.md: Attendance session, Roster snapshot).
--
-- One session per Class Offering and School date, shared by every Faculty
-- member who may record it. Opening it captures the Roster memberships
-- covering that date; refreshing it adds any rostered since, and never takes
-- one away, so no row of a snapshot is ever deleted.
CREATE TABLE app.attendance_session (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            uuid NOT NULL,
  class_offering_id    uuid NOT NULL,
  date                 date NOT NULL,
  opened_by_person_id  uuid NOT NULL,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  -- The offering and the Person belong to the session's own School (ADR-0001).
  CONSTRAINT attendance_session_class_offering_fk
    FOREIGN KEY (school_id, class_offering_id) REFERENCES app.class_offering (school_id, id),
  FOREIGN KEY (school_id, opened_by_person_id) REFERENCES app.person (school_id, id),
  CONSTRAINT attendance_session_one_per_date UNIQUE (school_id, class_offering_id, date),
  UNIQUE (school_id, id)
);

CREATE TABLE app.roster_snapshot_member (
  school_id              uuid NOT NULL,
  attendance_session_id  uuid NOT NULL,
  roster_membership_id   uuid NOT NULL,
  PRIMARY KEY (attendance_session_id, roster_membership_id),
  FOREIGN KEY (school_id, attendance_session_id) REFERENCES app.attendance_session (school_id, id),
  FOREIGN KEY (school_id, roster_membership_id) REFERENCES app.roster_membership (school_id, id)
);

-- Finding the snapshots a Roster membership is captured in.
CREATE INDEX roster_snapshot_member_membership ON app.roster_snapshot_member (school_id, roster_membership_id);

-- One Student's status for one Class Offering on one School date, at most one
-- of each. It names who last recorded it and when, which is why a first mark
-- needs no Audit record of its own. It stands apart from any session: a
-- Correction request may add one to a date nobody took.
CREATE TABLE app.attendance (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id              uuid NOT NULL,
  student_person_id      uuid NOT NULL,
  class_offering_id      uuid NOT NULL,
  date                   date NOT NULL,
  status                 text NOT NULL CONSTRAINT attendance_status_known CHECK (
    status IN ('present', 'tardy', 'excused_absence', 'unexcused_absence', 'absent_pending_review')
  ),
  recorded_by_person_id  uuid NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_class_offering_fk
    FOREIGN KEY (school_id, class_offering_id) REFERENCES app.class_offering (school_id, id),
  FOREIGN KEY (school_id, student_person_id) REFERENCES app.person (school_id, id),
  FOREIGN KEY (school_id, recorded_by_person_id) REFERENCES app.person (school_id, id),
  CONSTRAINT attendance_one_per_date UNIQUE (school_id, class_offering_id, date, student_person_id),
  UNIQUE (school_id, id)
);

-- Reading one Student's Attendance.
CREATE INDEX attendance_student ON app.attendance (school_id, student_person_id);

-- Nothing here is ever deleted by the application: a session and its snapshot
-- only grow, and a mark is changed, never removed. Which Student, offering and
-- date a mark is for never changes; its status, and who set it when, do.
GRANT SELECT ON app.attendance_session, app.roster_snapshot_member, app.attendance TO schoolgrid_app;
GRANT INSERT (school_id, class_offering_id, date, opened_by_person_id)
  ON app.attendance_session TO schoolgrid_app;
GRANT INSERT (school_id, attendance_session_id, roster_membership_id)
  ON app.roster_snapshot_member TO schoolgrid_app;
GRANT INSERT (school_id, student_person_id, class_offering_id, date, status, recorded_by_person_id)
  ON app.attendance TO schoolgrid_app;
GRANT UPDATE (status, recorded_by_person_id, recorded_at) ON app.attendance TO schoolgrid_app;

-- An expired Trial School is deleted whole (migrations/0018), its Attendance
-- with it: the one way any of it is deleted.
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
