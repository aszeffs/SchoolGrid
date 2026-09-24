-- Each Academic Year's Instructional days (CONTEXT.md: Instructional day): a
-- weekday pattern, plus dated exceptions that take a date out (a holiday) or
-- put one in (a make-up day). Which School dates the two make Instructional
-- days is the School calendar's to say (src/calendar), in one place.

-- The weekdays a year's pattern holds, by ISO number: 1 is Monday, 7 is
-- Sunday, as `extract(isodow ...)` counts them. The service writes them in
-- order, each once. Monday to Friday unless the year is given another, which
-- is also what the years that already exist are given.
ALTER TABLE app.academic_year
  ADD COLUMN weekdays smallint[] NOT NULL DEFAULT '{1,2,3,4,5}'
  CHECK (weekdays <@ '{1,2,3,4,5,6,7}' AND coalesce(array_ndims(weekdays), 1) = 1);

-- One date an Academic Year's pattern does not decide: `instructional` says
-- whether it is an Instructional day regardless.
--
-- A School date has at most one, whichever year it belongs to. That it also
-- falls inside its year is a matter of two rows, the year's bounds and the
-- exception's date, so the service checks it holding the year locked, as it
-- does a Term's bounds (migrations/0013).
CREATE TABLE app.instructional_day_exception (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL,
  academic_year_id  uuid NOT NULL,
  date              date NOT NULL,
  instructional     boolean NOT NULL,
  FOREIGN KEY (school_id, academic_year_id) REFERENCES app.academic_year (school_id, id),
  UNIQUE (school_id, date),
  UNIQUE (school_id, id)
);

-- An exception is added or removed, never changed: turning a holiday into a
-- make-up day is removing one and adding the other, each recorded.
GRANT SELECT, DELETE ON app.instructional_day_exception TO schoolgrid_app;
GRANT INSERT (school_id, academic_year_id, date, instructional) ON app.instructional_day_exception TO schoolgrid_app;

GRANT INSERT (weekdays), UPDATE (weekdays) ON app.academic_year TO schoolgrid_app;
