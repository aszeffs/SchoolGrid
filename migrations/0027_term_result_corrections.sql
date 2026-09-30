-- Correction requests for Term results (CONTEXT.md: Correction request): a
-- second kind of target, a published Term result, named by its Student and
-- Class Offering, with no date.
--
-- Its before and after are each a whole result: the value's label, held in
-- before_value and after_value as an Attendance status is, and a score and
-- comment of its own. Any of the three may change, the value alone need not;
-- a published result always carries a value, so both sides do. Only what is
-- allowed widens: every Attendance request stays as it was, and valid.
ALTER TABLE app.correction_request
  ADD COLUMN before_score    numeric(4, 1) CONSTRAINT correction_request_before_score_bounds CHECK (
    before_score BETWEEN 0 AND 100
  ),
  ADD COLUMN after_score     numeric(4, 1) CONSTRAINT correction_request_after_score_bounds CHECK (
    after_score BETWEEN 0 AND 100
  ),
  ADD COLUMN before_comment  text CONSTRAINT correction_request_before_comment_bounds CHECK (
    btrim(before_comment) <> '' AND char_length(before_comment) <= 500
  ),
  ADD COLUMN after_comment   text CONSTRAINT correction_request_after_comment_bounds CHECK (
    btrim(after_comment) <> '' AND char_length(after_comment) <= 500
  ),
  ALTER COLUMN date DROP NOT NULL,
  DROP CONSTRAINT correction_request_kind_known,
  ADD CONSTRAINT correction_request_kind_known CHECK (target_kind IN ('attendance', 'term_result')),
  -- An Attendance request names a date and nothing of a result's; a Term
  -- result request names no date, and changes a result that has a value.
  ADD CONSTRAINT correction_request_target_shape CHECK (
    CASE target_kind
      WHEN 'attendance' THEN date IS NOT NULL
        AND before_score IS NULL AND after_score IS NULL AND before_comment IS NULL AND after_comment IS NULL
      ELSE date IS NULL AND before_value IS NOT NULL
    END
  ),
  DROP CONSTRAINT correction_request_changes_something,
  ADD CONSTRAINT correction_request_changes_something CHECK (
    (before_value, before_score, before_comment) IS DISTINCT FROM (after_value, after_score, after_comment)
  );

GRANT INSERT (before_score, after_score, before_comment, after_comment) ON app.correction_request TO schoolgrid_app;
