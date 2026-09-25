-- A Faculty member's assignment to a Class Offering (CONTEXT.md: Teaching
-- assignment), bounded by School dates, first and last inclusive (ADR-0011).
-- A last date of null is an assignment still open: it runs to the end of its
-- Term.
--
-- Several Faculty members may be assigned to one offering at once, but one
-- Person's assignments to one offering never overlap: two would make ending
-- "the" assignment leave them teaching it through the other.
--
-- That the Person holds an active Faculty School membership is the service's
-- to check, holding that membership, since a membership is bounded by instants
-- and an assignment by School dates.
CREATE TABLE app.teaching_assignment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL,
  class_offering_id  uuid NOT NULL,
  faculty_person_id  uuid NOT NULL,
  first_date         date NOT NULL,
  last_date          date,
  -- The offering and the Person belong to the assignment's own School (ADR-0001).
  CONSTRAINT teaching_assignment_class_offering_fk
    FOREIGN KEY (school_id, class_offering_id) REFERENCES app.class_offering (school_id, id),
  FOREIGN KEY (school_id, faculty_person_id) REFERENCES app.person (school_id, id),
  CHECK (last_date IS NULL OR first_date <= last_date),
  CONSTRAINT teaching_assignment_no_overlap EXCLUDE USING gist (
    school_id WITH =,
    class_offering_id WITH =,
    faculty_person_id WITH =,
    daterange(first_date, last_date, '[]') WITH &&
  ),
  UNIQUE (school_id, id)
);

-- Finding a Person's assignments, when their Faculty membership ends.
CREATE INDEX teaching_assignment_person ON app.teaching_assignment (school_id, faculty_person_id);

-- An assignment falls inside its offering's Term. That is a matter of two
-- rows, so it is held by a trigger on each side: one refuses an assignment
-- written outside its Term, the other a Term moved so that an assignment would
-- fall outside it. Both name the same constraint, so the service can refuse
-- either as the Conflict it stands for.
--
-- The Term is held while an assignment is written, so a Term moved at the
-- same moment waits, and then finds the assignment when it checks.
CREATE FUNCTION app.refuse_teaching_assignment_outside_term() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  term_first date;
  term_last  date;
BEGIN
  SELECT t.first_date, t.last_date INTO term_first, term_last
  FROM app.class_offering o
  JOIN app.term t ON t.school_id = o.school_id AND t.id = o.term_id
  WHERE o.school_id = NEW.school_id AND o.id = NEW.class_offering_id
  FOR SHARE OF t;
  -- An offering that does not exist is the foreign key's to refuse.
  IF FOUND AND (NEW.first_date < term_first OR coalesce(NEW.last_date, term_last) > term_last) THEN
    RAISE EXCEPTION 'a Teaching assignment falls inside its Term'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'teaching_assignment_inside_term';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER teaching_assignment_inside_term
  BEFORE INSERT OR UPDATE ON app.teaching_assignment
  FOR EACH ROW
  EXECUTE FUNCTION app.refuse_teaching_assignment_outside_term();

CREATE FUNCTION app.refuse_term_stranding_teaching_assignment() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app.class_offering o
    JOIN app.teaching_assignment a ON a.school_id = o.school_id AND a.class_offering_id = o.id
    WHERE o.school_id = NEW.school_id AND o.term_id = NEW.id
      AND (a.first_date < NEW.first_date OR a.first_date > NEW.last_date OR a.last_date > NEW.last_date)
  ) THEN
    RAISE EXCEPTION 'a Teaching assignment falls inside its Term'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'teaching_assignment_inside_term';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER term_keeps_teaching_assignments
  AFTER UPDATE OF first_date, last_date ON app.term
  FOR EACH ROW
  EXECUTE FUNCTION app.refuse_term_stranding_teaching_assignment();

-- Which offering and Person an assignment is never changes: assigning another
-- is another Teaching assignment. Its bounds do. One that has begun is ended
-- rather than deleted, as the record of who taught when; the service deletes
-- only one that has not.
GRANT SELECT, DELETE ON app.teaching_assignment TO schoolgrid_app;
GRANT INSERT (school_id, class_offering_id, faculty_person_id, first_date, last_date)
  ON app.teaching_assignment TO schoolgrid_app;
GRANT UPDATE (first_date, last_date) ON app.teaching_assignment TO schoolgrid_app;
