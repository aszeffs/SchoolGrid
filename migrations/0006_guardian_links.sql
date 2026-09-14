-- A Guardian's link to one specific Student, carrying that link's Access
-- profile. A Guardian of two Students holds two rows with nothing linking them,
-- so each profile is changed and each link revoked on its own.
--
-- The profile is two independent permissions rather than an enum of named
-- modes, so every combination of them is expressible. Nothing enforces them
-- yet: the Attendance and Term result slices do.
CREATE TABLE app.guardian_link (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES app.school (id),
  guardian_person_id  uuid NOT NULL,
  student_person_id   uuid NOT NULL,
  attendance_read     boolean NOT NULL,
  results_read        boolean NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Null while the link is in force. Set only once the link has ended, so a link
  -- with an end is over, and there is no future end to wait for.
  ended_at            timestamptz,
  -- Both Persons belong to the link's own School (ADR-0001).
  FOREIGN KEY (school_id, guardian_person_id) REFERENCES app.person (school_id, id),
  FOREIGN KEY (school_id, student_person_id) REFERENCES app.person (school_id, id),
  CHECK (guardian_person_id <> student_person_id),
  CHECK (ended_at IS NULL OR ended_at >= created_at),
  -- The target of composite references from later School-scoped rows.
  UNIQUE (school_id, id)
);

-- A Guardian holds one link per Student: at most one in force for each pair.
-- Ended links stay beside it as the record of what access was held, and when.
CREATE UNIQUE INDEX guardian_link_in_force_key
  ON app.guardian_link (school_id, guardian_person_id, student_person_id)
  WHERE ended_at IS NULL;

-- As with memberships, a link is never deleted, and who it links never changes:
-- the application may insert one, change its profile, and end it. Its creation
-- time is set by the database alone, so it cannot be back-dated.
GRANT SELECT ON app.guardian_link TO schoolgrid_app;
GRANT INSERT (school_id, guardian_person_id, student_person_id, attendance_read, results_read)
  ON app.guardian_link TO schoolgrid_app;
GRANT UPDATE (attendance_read, results_read, ended_at) ON app.guardian_link TO schoolgrid_app;
