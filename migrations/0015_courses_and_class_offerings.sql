-- A School's Courses, and the Class Offerings that offer them in its Terms
-- (CONTEXT.md: Course, Class Offering).
--
-- Neither has any history to keep yet, so either may be deleted while nothing
-- refers to it. The database holds that: deleting a Course that is offered, or
-- a Term that has Class Offerings, fails on the reference, and the service
-- names the kind of record that would have been stranded. The slices that let
-- Teaching assignments and Roster memberships refer to a Class Offering extend
-- the same refusal to it.

-- A reusable subject definition. Its name, and its code when it has one, each
-- name one Course in the School, ignoring letter case: "Algebra" and "algebra"
-- would be one subject told two ways.
CREATE TABLE app.course (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES app.school (id),
  name       text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 200),
  code       text CHECK (btrim(code) <> '' AND char_length(code) <= 200),
  -- The target of composite references from later School-scoped rows.
  UNIQUE (school_id, id)
);

CREATE UNIQUE INDEX course_name_unique ON app.course (school_id, lower(name));
CREATE UNIQUE INDEX course_code_unique ON app.course (school_id, lower(code)) WHERE code IS NOT NULL;

-- A Course offered for one Term, in the Course's and the Term's own School
-- (ADR-0001). One Course may be offered more than once in a Term, each told
-- apart by its label, which is unique among that Course's offerings in that
-- Term ignoring letter case. At most one of them goes without a label: two
-- with none could not be told apart.
CREATE TABLE app.class_offering (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL,
  course_id  uuid NOT NULL,
  term_id    uuid NOT NULL,
  label      text CHECK (btrim(label) <> '' AND char_length(label) <= 200),
  CONSTRAINT class_offering_course_fk FOREIGN KEY (school_id, course_id) REFERENCES app.course (school_id, id),
  CONSTRAINT class_offering_term_fk FOREIGN KEY (school_id, term_id) REFERENCES app.term (school_id, id),
  UNIQUE (school_id, id)
);

-- A label is never blank, so an empty one stands for none without colliding.
CREATE UNIQUE INDEX class_offering_label_unique
  ON app.class_offering (school_id, course_id, term_id, lower(coalesce(label, '')));

-- Finding a Term's offerings, when the Term is changed or deleted.
CREATE INDEX class_offering_term ON app.class_offering (school_id, term_id);

-- Which School a Course belongs to never changes; its name and code do.
GRANT SELECT, DELETE ON app.course TO schoolgrid_app;
GRANT INSERT (school_id, name, code) ON app.course TO schoolgrid_app;
GRANT UPDATE (name, code) ON app.course TO schoolgrid_app;

-- Which Course and Term an offering offers never changes: offering another is
-- another Class Offering. Only its label does.
GRANT SELECT, DELETE ON app.class_offering TO schoolgrid_app;
GRANT INSERT (school_id, course_id, term_id, label) ON app.class_offering TO schoolgrid_app;
GRANT UPDATE (label) ON app.class_offering TO schoolgrid_app;
