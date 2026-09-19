-- The public demo's data: one invented School, and a Person with a User account
-- in each School role, whose sign-ins the demo publishes on its sign-in page.
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

INSERT INTO app.school (id, name) VALUES
  ('5c4001a0-0000-4000-8000-000000000001', 'Riverbend Demo School');

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

COMMIT;
