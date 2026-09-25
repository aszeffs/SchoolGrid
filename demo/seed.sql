-- The public demo's data: one invented School, and a Person with a User account
-- in each School role, whose sign-ins the demo publishes on its sign-in page.
-- Around them, an Academic Year of Terms, Courses and Class Offerings, taught
-- by the Faculty member and attended by the Student among invented classmates.
-- Every name here is made up. No real School's records belong in the demo.
--
-- Run as the schema owner against a freshly migrated database, with
-- ON_ERROR_STOP so a failure stops it:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 --file demo/seed.sql
--
-- It lives outside the image, which never needs it, and runs once per fresh
-- database: the identifiers are fixed, so running it twice fails rather than
-- seeding a second copy. The nightly reset drops the schema before running it.
--
-- The passwords are public on purpose. They are shown on the demo's sign-in
-- page (src/http/demo.ts holds them in plain text) and allowed in
-- .gitleaks.toml. Each hash below is that password hashed exactly as
-- src/authentication/passwords.ts hashes one; tests/demo.test.ts signs in with
-- each, so a hash that does not match fails there.
--
-- Nothing here writes an Audit record. The seed is not an action anyone took in
-- the School, and an Audit record claiming one would be false.

BEGIN;

-- The demo is visited from anywhere, so its School keeps UTC and favours no
-- visitor's day over another's.
INSERT INTO app.school (id, name, timezone) VALUES
  ('5c4001a0-0000-4000-8000-000000000001', 'Riverbend Demo School', 'UTC');

INSERT INTO app.user_account (id, username, password_hash) VALUES
  ('5c4001a0-0000-4000-8000-000000000101', 'demo.administrator',
   'scrypt$32768$8$3$pNkqEqsy24NeQYwhqRDJ0w==$BL26vwqBZFmCK8sRQaNDuGO4pEgg0hMeKLsk7jupNnA='),
  ('5c4001a0-0000-4000-8000-000000000102', 'demo.faculty',
   'scrypt$32768$8$3$jfZRPeT0DRxS+1BHYQ1RSw==$iwDF3bDbPjqYddXK2W6O98sV1EODy3LsRzt9M0cw1Xs='),
  ('5c4001a0-0000-4000-8000-000000000103', 'demo.student',
   'scrypt$32768$8$3$iBWThcqwc+RklBjxpNGgGA==$oh59FsTPN+7YsOKypcx1XLmsttpkaBocFGsYp8J40RM='),
  ('5c4001a0-0000-4000-8000-000000000104', 'demo.guardian',
   'scrypt$32768$8$3$T44i/8qSGyb2do+VmN8HgQ==$y67Bkj6xKQ8qMwXBs+Yw4ahpIh4IT+Gew4/+bSMmYPM=');

INSERT INTO app.person (id, school_id, user_account_id, display_name) VALUES
  ('5c4001a0-0000-4000-8000-000000000201', '5c4001a0-0000-4000-8000-000000000001',
   '5c4001a0-0000-4000-8000-000000000101', 'Morgan Reyes'),
  ('5c4001a0-0000-4000-8000-000000000202', '5c4001a0-0000-4000-8000-000000000001',
   '5c4001a0-0000-4000-8000-000000000102', 'Sam Achterberg'),
  ('5c4001a0-0000-4000-8000-000000000203', '5c4001a0-0000-4000-8000-000000000001',
   '5c4001a0-0000-4000-8000-000000000103', 'Jamie Lindqvist'),
  ('5c4001a0-0000-4000-8000-000000000204', '5c4001a0-0000-4000-8000-000000000001',
   '5c4001a0-0000-4000-8000-000000000104', 'Alex Lindqvist');

INSERT INTO app.school_membership (school_id, person_id, role) VALUES
  ('5c4001a0-0000-4000-8000-000000000001', '5c4001a0-0000-4000-8000-000000000201', 'school_administrator'),
  ('5c4001a0-0000-4000-8000-000000000001', '5c4001a0-0000-4000-8000-000000000202', 'faculty'),
  ('5c4001a0-0000-4000-8000-000000000001', '5c4001a0-0000-4000-8000-000000000203', 'student'),
  ('5c4001a0-0000-4000-8000-000000000001', '5c4001a0-0000-4000-8000-000000000204', 'guardian');

INSERT INTO app.enrollment (school_id, student_person_id) VALUES
  ('5c4001a0-0000-4000-8000-000000000001', '5c4001a0-0000-4000-8000-000000000203');

-- A full Access profile: the Guardian reads both Attendance and Term results.
INSERT INTO app.guardian_link
  (school_id, guardian_person_id, student_person_id, attendance_read, results_read)
VALUES
  ('5c4001a0-0000-4000-8000-000000000001', '5c4001a0-0000-4000-8000-000000000204',
   '5c4001a0-0000-4000-8000-000000000203', true, true);

-- Persons no one signs in as, so that a class has a roster and the Student has
-- classmates: a second Faculty member, and six more enrolled Students.
INSERT INTO app.person (id, school_id, display_name) VALUES
  ('5c4001a0-0000-4000-8000-000000000205', '5c4001a0-0000-4000-8000-000000000001', 'Priya Okonkwo'),
  ('5c4001a0-0000-4000-8000-000000000211', '5c4001a0-0000-4000-8000-000000000001', 'Avery Castellano'),
  ('5c4001a0-0000-4000-8000-000000000212', '5c4001a0-0000-4000-8000-000000000001', 'Casey Moreau'),
  ('5c4001a0-0000-4000-8000-000000000213', '5c4001a0-0000-4000-8000-000000000001', 'Jordan Okafor'),
  ('5c4001a0-0000-4000-8000-000000000214', '5c4001a0-0000-4000-8000-000000000001', 'Quinn Adebayo'),
  ('5c4001a0-0000-4000-8000-000000000215', '5c4001a0-0000-4000-8000-000000000001', 'Riley Fernsby'),
  ('5c4001a0-0000-4000-8000-000000000216', '5c4001a0-0000-4000-8000-000000000001', 'Taylor Nakamura');

INSERT INTO app.school_membership (school_id, person_id, role)
SELECT school_id, id, CASE WHEN id = '5c4001a0-0000-4000-8000-000000000205' THEN 'faculty' ELSE 'student' END
FROM app.person
WHERE school_id = '5c4001a0-0000-4000-8000-000000000001' AND user_account_id IS NULL;

INSERT INTO app.enrollment (school_id, student_person_id)
SELECT school_id, id
FROM app.person
WHERE school_id = '5c4001a0-0000-4000-8000-000000000001' AND user_account_id IS NULL
  AND id <> '5c4001a0-0000-4000-8000-000000000205';

-- The Academic Year, built around the day the seed runs, so that the nightly
-- reset always leaves a Term running whatever the date. It is built around
-- today as the School sees it, in the School's timezone. `demo.today` names another day to build
-- around instead, which tests/demo.test.ts sets to seed on the days a calendar
-- is most likely to get wrong.
--
-- The year runs from the 1st of August to the 31st of July, the whole of it,
-- so no day falls between two years. Its first day is kept for the rest of the
-- transaction, and every date below is counted from it.
DO $$
DECLARE
  today date := coalesce(
    nullif(current_setting('demo.today', true), '')::date,
    (SELECT (now() AT TIME ZONE timezone)::date FROM app.school WHERE id = '5c4001a0-0000-4000-8000-000000000001')
  );
BEGIN
  PERFORM set_config('demo.year_start', make_date(
    extract(year FROM today)::int - CASE WHEN extract(month FROM today) < 8 THEN 1 ELSE 0 END, 8, 1
  )::text, true);
END
$$;

-- Taught Monday to Friday, as "2026–27" names the year beginning in August 2026.
INSERT INTO app.academic_year (id, school_id, name, first_date, last_date, weekdays)
SELECT '5c4001a0-0000-4000-8000-000000000300', '5c4001a0-0000-4000-8000-000000000001',
       to_char(start, 'YYYY') || '–' || to_char(start + interval '1 year', 'YY'),
       start, (start + interval '1 year' - interval '1 day')::date, '{1,2,3,4,5}'
FROM (SELECT current_setting('demo.year_start')::date AS start) AS year;

-- Three Terms that cover the year with no gap: August to December, January to
-- April, and May to July.
INSERT INTO app.term (id, school_id, academic_year_id, name, first_date, last_date)
SELECT id::uuid, '5c4001a0-0000-4000-8000-000000000001', '5c4001a0-0000-4000-8000-000000000300', name,
       (start + first_month * interval '1 month')::date,
       (start + next_month * interval '1 month' - interval '1 day')::date
FROM (SELECT current_setting('demo.year_start')::date AS start) AS year,
     (VALUES ('5c4001a0-0000-4000-8000-000000000301', 'Autumn Term', 0, 5),
             ('5c4001a0-0000-4000-8000-000000000302', 'Spring Term', 5, 9),
             ('5c4001a0-0000-4000-8000-000000000303', 'Summer Term', 9, 12)) AS t (id, name, first_month, next_month);

-- A few holidays, each the first given weekday (1 is Monday) on or after a day
-- counted from the start of the year, so that each lands on a day the pattern
-- would otherwise have taught.
INSERT INTO app.instructional_day_exception (school_id, academic_year_id, date, instructional)
SELECT '5c4001a0-0000-4000-8000-000000000001', '5c4001a0-0000-4000-8000-000000000300',
       from_day + (weekday - extract(isodow FROM from_day)::int + 7) % 7, false
FROM (
  SELECT (current_setting('demo.year_start')::date + after)::date AS from_day, weekday
  FROM (VALUES (interval '1 month', 1),
               (interval '2 months 12 days', 1),
               (interval '6 months 14 days', 1),
               (interval '8 months 10 days', 5)) AS h (after, weekday)
) AS holidays;

INSERT INTO app.course (id, school_id, name, code) VALUES
  ('5c4001a0-0000-4000-8000-000000000401', '5c4001a0-0000-4000-8000-000000000001', 'Mathematics', 'MATH'),
  ('5c4001a0-0000-4000-8000-000000000402', '5c4001a0-0000-4000-8000-000000000001', 'English Literature', 'ENG'),
  ('5c4001a0-0000-4000-8000-000000000403', '5c4001a0-0000-4000-8000-000000000001', 'Biology', 'BIO'),
  ('5c4001a0-0000-4000-8000-000000000404', '5c4001a0-0000-4000-8000-000000000001', 'World History', 'HIST'),
  ('5c4001a0-0000-4000-8000-000000000405', '5c4001a0-0000-4000-8000-000000000001', 'Art', 'ART');

-- Every Course in every Term, Mathematics twice, told apart by its label.
INSERT INTO app.class_offering (school_id, course_id, term_id, label)
SELECT t.school_id, c.id, t.id, l.label
FROM app.term t
CROSS JOIN app.course c
JOIN (VALUES ('5c4001a0-0000-4000-8000-000000000401'::uuid, 'Section A'),
             ('5c4001a0-0000-4000-8000-000000000401'::uuid, 'Section B'),
             ('5c4001a0-0000-4000-8000-000000000402'::uuid, NULL),
             ('5c4001a0-0000-4000-8000-000000000403'::uuid, NULL),
             ('5c4001a0-0000-4000-8000-000000000404'::uuid, NULL),
             ('5c4001a0-0000-4000-8000-000000000405'::uuid, NULL)) AS l (course_id, label) ON l.course_id = c.id
WHERE t.academic_year_id = '5c4001a0-0000-4000-8000-000000000300';

-- The demo Faculty member teaches Mathematics and Biology, the other Faculty
-- member the rest, each for the whole of every Term.
INSERT INTO app.teaching_assignment (school_id, class_offering_id, faculty_person_id, first_date)
SELECT o.school_id, o.id,
       CASE WHEN o.course_id IN ('5c4001a0-0000-4000-8000-000000000401', '5c4001a0-0000-4000-8000-000000000403')
            THEN '5c4001a0-0000-4000-8000-000000000202'::uuid
            ELSE '5c4001a0-0000-4000-8000-000000000205'::uuid END,
       t.first_date
FROM app.class_offering o
JOIN app.term t ON t.school_id = o.school_id AND t.id = o.term_id;

-- Every Student takes every Course but Art, for the whole of every Term: the
-- demo Student and the first three invented ones in Mathematics Section A,
-- the other three in Section B. The last three take Art as well.
INSERT INTO app.roster_membership (school_id, class_offering_id, student_person_id, first_date)
SELECT o.school_id, o.id, s.id, t.first_date
FROM app.class_offering o
JOIN app.term t ON t.school_id = o.school_id AND t.id = o.term_id
JOIN app.enrollment e ON e.school_id = o.school_id
JOIN app.person s ON s.school_id = e.school_id AND s.id = e.student_person_id
WHERE CASE o.course_id
        WHEN '5c4001a0-0000-4000-8000-000000000401' THEN
          (o.label = 'Section A') = (s.id <= '5c4001a0-0000-4000-8000-000000000213')
        WHEN '5c4001a0-0000-4000-8000-000000000405' THEN
          s.id >= '5c4001a0-0000-4000-8000-000000000214'
        ELSE true
      END;

COMMIT;
