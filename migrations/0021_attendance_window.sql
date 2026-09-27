-- Each School's Attendance window (CONTEXT.md: Attendance window): how many
-- days after a School date its Attendance may still be recorded or corrected
-- normally. 0 is the same day only. Every School, those that exist already
-- included, starts at 7.
--
-- One setting governs every School date: there is no history of it, so
-- changing it opens or closes past dates at once.
ALTER TABLE app.school
  ADD COLUMN attendance_window smallint NOT NULL DEFAULT 7
  CONSTRAINT school_attendance_window_bounds CHECK (attendance_window BETWEEN 0 AND 60);

GRANT UPDATE (attendance_window) ON app.school TO schoolgrid_app;
