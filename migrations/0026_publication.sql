-- Publication (CONTEXT.md: Publication; ADR-0003): the act that publishes a
-- Class Offering's Term results carrying a value, every one not yet published,
-- at once. An offering may be published more than once, each act publishing
-- only what the last left, so each is its own row, naming who performed it,
-- when, and how many results it published: never none.
CREATE TABLE app.publication (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id               uuid NOT NULL,
  class_offering_id       uuid NOT NULL,
  published_by_person_id  uuid NOT NULL,
  published_at            timestamptz NOT NULL DEFAULT now(),
  result_count            integer NOT NULL CONSTRAINT publication_publishes_some CHECK (result_count > 0),
  -- Everything it names belongs to its own School (ADR-0001).
  FOREIGN KEY (school_id, class_offering_id) REFERENCES app.class_offering (school_id, id),
  FOREIGN KEY (school_id, published_by_person_id) REFERENCES app.person (school_id, id),
  UNIQUE (school_id, id)
);

CREATE INDEX publication_class_offering ON app.publication (school_id, class_offering_id);

-- A Publication is a fact: it is written once and never changed or removed.
GRANT SELECT ON app.publication TO schoolgrid_app;
GRANT INSERT (school_id, class_offering_id, published_by_person_id, result_count) ON app.publication TO schoolgrid_app;

-- The Publication that published a result; null while it is a draft.
ALTER TABLE app.term_result ADD COLUMN publication_id uuid;
ALTER TABLE app.term_result
  ADD CONSTRAINT term_result_publication_fk
  FOREIGN KEY (school_id, publication_id) REFERENCES app.publication (school_id, id);
GRANT UPDATE (publication_id) ON app.term_result TO schoolgrid_app;

-- Publication cannot be undone: a published result stays published by the
-- Publication that published it, and only a result carrying a value is ever
-- published. A published result's content still changes, through an approved
-- Correction request, but never back to having no value.
CREATE FUNCTION app.term_result_publication_is_final() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.publication_id IS NOT NULL AND NEW.publication_id IS DISTINCT FROM OLD.publication_id THEN
    RAISE EXCEPTION 'a published Term result stays published'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.publication_id IS NOT NULL AND NEW.result_value_id IS NULL THEN
    RAISE EXCEPTION 'a published Term result carries a value'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER term_result_publication_is_final
  BEFORE UPDATE ON app.term_result
  FOR EACH ROW EXECUTE FUNCTION app.term_result_publication_is_final();

-- An expired Trial School is deleted whole (migrations/0018), its
-- Publications with it: the one way any is deleted.
CREATE OR REPLACE FUNCTION app.delete_expired_trial_school(target uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  expires_at timestamptz;
BEGIN
  -- Locked, so a sweep running alongside waits here and then finds it gone.
  SELECT trial_expires_at INTO expires_at FROM app.school WHERE id = target FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF expires_at IS NULL OR expires_at > now() THEN
    RAISE EXCEPTION 'only a Trial School past its expiry may be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM app.term_result WHERE school_id = target;
  DELETE FROM app.publication WHERE school_id = target;
  DELETE FROM app.correction_request WHERE school_id = target;
  DELETE FROM app.attendance WHERE school_id = target;
  DELETE FROM app.roster_snapshot_member WHERE school_id = target;
  DELETE FROM app.attendance_session WHERE school_id = target;
  DELETE FROM app.roster_membership WHERE school_id = target;
  DELETE FROM app.teaching_assignment WHERE school_id = target;
  DELETE FROM app.class_offering WHERE school_id = target;
  DELETE FROM app.course WHERE school_id = target;
  DELETE FROM app.instructional_day_exception WHERE school_id = target;
  DELETE FROM app.term WHERE school_id = target;
  DELETE FROM app.academic_year WHERE school_id = target;
  DELETE FROM app.invitation WHERE school_id = target;
  DELETE FROM app.enrollment WHERE school_id = target;
  DELETE FROM app.guardian_link WHERE school_id = target;
  DELETE FROM app.school_membership WHERE school_id = target;
  DELETE FROM app.audit_record WHERE school_id = target;
  DELETE FROM app.result_value WHERE school_id = target;
  DELETE FROM app.result_value_scale_version WHERE school_id = target;
  DELETE FROM app.person WHERE school_id = target;

  -- An account created here that has since gone on to another School belongs
  -- to that School's records too, so it stays, no longer counted as this
  -- one's. Every other is deleted, and its Sessions with it.
  DELETE FROM app.user_account account
  WHERE account.created_in_school_id = target
    AND NOT EXISTS (SELECT 1 FROM app.person WHERE user_account_id = account.id)
    AND NOT EXISTS (SELECT 1 FROM app.invitation WHERE redeemed_by_user_account_id = account.id)
    AND NOT EXISTS (SELECT 1 FROM app.platform_administrator WHERE user_account_id = account.id);
  UPDATE app.user_account SET created_in_school_id = NULL WHERE created_in_school_id = target;

  DELETE FROM app.school WHERE id = target;
  RETURN true;
END
$$;
