-- A School observes its School dates in its own timezone (CONTEXT.md: School,
-- School date), named by its IANA identifier, such as 'America/New_York'. The
-- service converts an instant to a School date through it (src/calendar), and
-- nowhere else.

-- The timezones a School may have: every name the database itself knows,
-- exactly as it spells it, so every School date the database works out has a
-- timezone it can interpret.
--
-- Copied here once rather than consulted live. pg_timezone_names reads every
-- zone file on each query, which takes seconds on some platforms, and a School
-- referring to its timezone by foreign key holds against a direct write as
-- much as against the service. A newer tzdata that adds a zone adds it here
-- only through a later migration; one never removes a name, so none held here
-- stops being interpretable.
CREATE TABLE app.timezone (
  name  text PRIMARY KEY
);

INSERT INTO app.timezone (name)
SELECT DISTINCT name FROM pg_catalog.pg_timezone_names;

GRANT SELECT ON app.timezone TO schoolgrid_app;

-- Existing Schools are given 'UTC', a fixed default favouring no School over
-- another, and each School Administrator can correct theirs until the School's
-- first Academic Year exists (ADR-0011).
--
-- The default stays on the column for now. The image one deploy behind this
-- one creates a School by name alone, and must still be able to while this
-- migration is applied before it is replaced (#92). The service itself always
-- names a timezone, and a later migration drops the default.
ALTER TABLE app.school
  ADD COLUMN timezone text NOT NULL DEFAULT 'UTC' REFERENCES app.timezone (name);

-- A School's timezone is the one thing about it the application may change.
-- Its name is set at provisioning, and a School is never deleted: everything
-- it owns refers to it.
REVOKE UPDATE, DELETE ON app.school FROM schoolgrid_app;
GRANT UPDATE (timezone) ON app.school TO schoolgrid_app;
