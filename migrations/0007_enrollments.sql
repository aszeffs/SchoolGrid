-- A Student's bounded participation in a School. An Enrollment is open from
-- when it is recorded until it is ended, and a Student holds at most one open
-- at a time; ended ones stay beside it as the Student's history.
--
-- Nothing here, and nothing on the Student's membership, records whether the
-- Student's access is full or narrowed. That is derived from whether an open
-- Enrollment exists, when a request arrives, so a returning Student's access
-- widens with no repair step and no flag can drift from the Enrollment it
-- would describe. Do not add one.
CREATE TABLE app.enrollment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES app.school (id),
  student_person_id  uuid NOT NULL,
  started_at         timestamptz NOT NULL DEFAULT now(),
  -- Both null while the Enrollment is open, and both set once it has ended:
  -- an Enrollment does not end without a reason, and "transfer" is one such
  -- reason, not a movement of records.
  ended_at           timestamptz,
  end_reason         text CHECK (end_reason <> '' AND char_length(end_reason) <= 1000),
  -- The Student belongs to the Enrollment's own School (ADR-0001).
  FOREIGN KEY (school_id, student_person_id) REFERENCES app.person (school_id, id),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- The target of composite references from later School-scoped rows.
  UNIQUE (school_id, id)
);

CREATE UNIQUE INDEX enrollment_open_key
  ON app.enrollment (school_id, student_person_id)
  WHERE ended_at IS NULL;

-- An Enrollment is never deleted, and whose it is and when it began never
-- change: the application may record one and end it. Its start is set by the
-- database alone, so it cannot be back-dated.
GRANT SELECT ON app.enrollment TO schoolgrid_app;
GRANT INSERT (school_id, student_person_id) ON app.enrollment TO schoolgrid_app;
GRANT UPDATE (ended_at, end_reason) ON app.enrollment TO schoolgrid_app;

-- An Enrollment's end is written once. The grant above lets the application set
-- it, so nothing but this stops it being cleared or rewritten afterwards: that
-- would reopen a departed Student's full access, or change why they left. A
-- returning Student is given a new Enrollment, never an old one reopened.
CREATE FUNCTION app.refuse_ended_enrollment_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'an ended Enrollment cannot change'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER enrollment_end_is_final
  BEFORE UPDATE ON app.enrollment
  FOR EACH ROW
  WHEN (OLD.ended_at IS NOT NULL)
  EXECUTE FUNCTION app.refuse_ended_enrollment_change();
