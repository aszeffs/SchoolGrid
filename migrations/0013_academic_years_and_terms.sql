-- A School's Academic Years, each divided into Terms (CONTEXT.md: Academic
-- Year, Term). Both are bounded by School dates, first and last inclusive:
-- the days as the School saw them, not instants (ADR-0011).
--
-- Neither has any history to keep yet, so either may be deleted while nothing
-- refers to it. The slices that let Class Offerings, Teaching assignments and
-- Roster memberships refer to them extend that refusal.

-- Academic Years in one School never overlap, but may leave School dates
-- between them, such as a summer break, that fall in none.
CREATE TABLE app.academic_year (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES app.school (id),
  name        text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 200),
  first_date  date NOT NULL,
  last_date   date NOT NULL,
  CHECK (first_date <= last_date),
  CONSTRAINT academic_year_no_overlap EXCLUDE USING gist (
    school_id WITH =,
    daterange(first_date, last_date, '[]') WITH &&
  ),
  -- The target of composite references from later School-scoped rows.
  UNIQUE (school_id, id)
);

-- A Term belongs to one Academic Year, in the year's own School (ADR-0001).
--
-- Terms in a year never overlap, which the constraint below holds row by row.
-- That they also leave no gap and exactly cover their year is a property of
-- the whole set, not of any one row, so the service checks it in the
-- transaction that changes any of them, holding the year locked.
--
-- The overlap check waits for the end of the transaction. Moving the boundary
-- between two adjacent Terms changes both, and whichever is written first
-- would otherwise overlap the other for the moment in between.
--
-- A Term's place in its year is its dates' order. With no overlap and no gap
-- there is no other order they could have, so none is stored to disagree.
CREATE TABLE app.term (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL,
  academic_year_id  uuid NOT NULL,
  name              text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 200),
  first_date        date NOT NULL,
  last_date         date NOT NULL,
  FOREIGN KEY (school_id, academic_year_id) REFERENCES app.academic_year (school_id, id),
  CHECK (first_date <= last_date),
  CONSTRAINT term_no_overlap EXCLUDE USING gist (
    academic_year_id WITH =,
    daterange(first_date, last_date, '[]') WITH &&
  ) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (school_id, id)
);

-- Which School and year a row belongs to never changes. Its name and bounds
-- do, and it may be deleted: the service refuses a deletion that would leave
-- something without the period it belongs to.
GRANT SELECT, DELETE ON app.academic_year TO schoolgrid_app;
GRANT INSERT (school_id, name, first_date, last_date) ON app.academic_year TO schoolgrid_app;
GRANT UPDATE (name, first_date, last_date) ON app.academic_year TO schoolgrid_app;

GRANT SELECT, DELETE ON app.term TO schoolgrid_app;
GRANT INSERT (school_id, academic_year_id, name, first_date, last_date) ON app.term TO schoolgrid_app;
GRANT UPDATE (name, first_date, last_date) ON app.term TO schoolgrid_app;

-- A School's timezone is fixed once its first Academic Year exists (ADR-0011):
-- moving it would shift the School date of every instant already bounded
-- against it. Held here as well as in the service, so a direct write is
-- refused too, whoever makes it.
--
-- The service creates an Academic Year holding its School's row share-locked,
-- and changes the timezone holding it locked for update, so neither can land
-- between the other's check and its write.
CREATE FUNCTION app.refuse_fixed_timezone_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.academic_year WHERE school_id = NEW.id) THEN
    RAISE EXCEPTION 'a School''s timezone is fixed once its first Academic Year exists'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER school_timezone_is_fixed
  BEFORE UPDATE OF timezone ON app.school
  FOR EACH ROW
  WHEN (OLD.timezone IS DISTINCT FROM NEW.timezone)
  EXECUTE FUNCTION app.refuse_fixed_timezone_change();
