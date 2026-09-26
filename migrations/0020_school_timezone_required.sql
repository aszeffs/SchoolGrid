-- Every School names its timezone (CONTEXT.md: School). Migration 0012 kept
-- 'UTC' as the column's default only so that the image one deploy behind it
-- could still create a School by name alone (#92). No image in production does
-- any more, so the default goes, as 0012 promised.
ALTER TABLE app.school ALTER COLUMN timezone DROP DEFAULT;
