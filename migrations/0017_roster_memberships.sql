-- A Student's participation in a Class Offering (CONTEXT.md: Roster
-- membership), bounded by School dates, first and last inclusive (ADR-0011).
-- A last date of null is a membership still open: it runs to the end of its
-- Term.
--
-- A Student may be on the rosters of several offerings at once, but one
-- Person's memberships of one offering never overlap: two would make ending
-- "the" membership leave them on the roster through the other.
--
-- That the Person holds an open Enrollment is the service's to check, holding
-- that Enrollment, since an Enrollment is bounded by instants and a membership
-- by School dates.
CREATE TABLE app.roster_membership (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL,
  class_offering_id  uuid NOT NULL,
  student_person_id  uuid NOT NULL,
  first_date         date NOT NULL,
  last_date          date,
  -- The offering and the Person belong to the membership's own School (ADR-0001).
  CONSTRAINT roster_membership_class_offering_fk
    FOREIGN KEY (school_id, class_offering_id) REFERENCES app.class_offering (school_id, id),
  FOREIGN KEY (school_id, student_person_id) REFERENCES app.person (school_id, id),
  CHECK (last_date IS NULL OR first_date <= last_date),
  CONSTRAINT roster_membership_no_overlap EXCLUDE USING gist (
    school_id WITH =,
    class_offering_id WITH =,
    student_person_id WITH =,
    daterange(first_date, last_date, '[]') WITH &&
  ),
  UNIQUE (school_id, id)
);

-- Finding a Person's memberships, when their Enrollment ends and when they read their classes.
CREATE INDEX roster_membership_person ON app.roster_membership (school_id, student_person_id);

-- A membership falls inside its offering's Term, held by a trigger on each
-- side as a Teaching assignment's is (migrations/0016), and for the same
-- reasons.
CREATE FUNCTION app.refuse_roster_membership_outside_term() RETURNS trigger
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
    RAISE EXCEPTION 'a Roster membership falls inside its Term'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'roster_membership_inside_term';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER roster_membership_inside_term
  BEFORE INSERT OR UPDATE ON app.roster_membership
  FOR EACH ROW
  EXECUTE FUNCTION app.refuse_roster_membership_outside_term();

CREATE FUNCTION app.refuse_term_stranding_roster_membership() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app.class_offering o
    JOIN app.roster_membership m ON m.school_id = o.school_id AND m.class_offering_id = o.id
    WHERE o.school_id = NEW.school_id AND o.term_id = NEW.id
      AND (m.first_date < NEW.first_date OR m.first_date > NEW.last_date OR m.last_date > NEW.last_date)
  ) THEN
    RAISE EXCEPTION 'a Roster membership falls inside its Term'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'roster_membership_inside_term';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER term_keeps_roster_memberships
  AFTER UPDATE OF first_date, last_date ON app.term
  FOR EACH ROW
  EXECUTE FUNCTION app.refuse_term_stranding_roster_membership();

-- Which offering and Person a membership joins never changes: rostering
-- another is another Roster membership. Its bounds do. One that has begun is
-- ended rather than deleted, as the record of who was in the class when; the
-- service deletes only one that has not.
GRANT SELECT, DELETE ON app.roster_membership TO schoolgrid_app;
GRANT INSERT (school_id, class_offering_id, student_person_id, first_date, last_date)
  ON app.roster_membership TO schoolgrid_app;
GRANT UPDATE (first_date, last_date) ON app.roster_membership TO schoolgrid_app;
