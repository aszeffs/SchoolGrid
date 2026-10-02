-- Each School's Result value scale (CONTEXT.md: Result value scale): the
-- ordered labels a Term result may carry, each with an optional description.
--
-- The scale is versioned. A save never changes a version; it adds the next
-- one, and a School's current scale is its highest-numbered version. Every
-- School starts with a first version holding A, B, C, D and F: those that
-- exist already get it here, and every School created from now on gets it as
-- it is created.
CREATE TABLE app.result_value_scale_version (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES app.school (id),
  number              integer NOT NULL CONSTRAINT result_value_scale_version_number_positive CHECK (number >= 1),
  saved_at            timestamptz NOT NULL DEFAULT now(),
  -- Who saved it; null for the first version, which no one saved.
  saved_by_person_id  uuid,
  FOREIGN KEY (school_id, saved_by_person_id) REFERENCES app.person (school_id, id),
  UNIQUE (school_id, number),
  UNIQUE (school_id, id)
);

-- One value of one version, at its place in the order from 1.
CREATE TABLE app.result_value (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                 uuid NOT NULL,
  scale_version_id          uuid NOT NULL,
  position                  smallint NOT NULL CONSTRAINT result_value_position_positive CHECK (position >= 1),
  label                     text NOT NULL CONSTRAINT result_value_label_bounds CHECK (
    label <> '' AND label = btrim(label) AND char_length(label) <= 20
  ),
  description               text CONSTRAINT result_value_description_bounds CHECK (
    description <> '' AND description = btrim(description) AND char_length(description) <= 200
  ),
  FOREIGN KEY (school_id, scale_version_id) REFERENCES app.result_value_scale_version (school_id, id),
  UNIQUE (scale_version_id, position),
  UNIQUE (school_id, id)
);

-- No two values of a version share a label, whatever their letter case.
CREATE UNIQUE INDEX result_value_label_unique ON app.result_value (scale_version_id, lower(label));

-- A version holds at least one value. Checked as its transaction commits, so
-- a version and its values are written one after the other; values are never
-- deleted, so a version that had one keeps it.
CREATE FUNCTION app.result_value_scale_version_has_values() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.result_value WHERE scale_version_id = NEW.id) THEN
    RAISE EXCEPTION 'a Result value scale version holds at least one value'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'result_value_scale_version_has_values';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER result_value_scale_version_has_values
  AFTER INSERT ON app.result_value_scale_version
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.result_value_scale_version_has_values();

-- The first version, A to F, for a School that has none yet.
CREATE FUNCTION app.create_first_result_value_scale(target uuid) RETURNS void
  LANGUAGE sql
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH version AS (
    INSERT INTO app.result_value_scale_version (school_id, number) VALUES (target, 1) RETURNING id
  )
  INSERT INTO app.result_value (school_id, scale_version_id, position, label)
  SELECT target, version.id, position, label
  FROM version, unnest(ARRAY['A', 'B', 'C', 'D', 'F']) WITH ORDINALITY AS labels (label, position);
$$;

SELECT app.create_first_result_value_scale(id) FROM app.school;

CREATE FUNCTION app.school_starts_with_result_value_scale() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.create_first_result_value_scale(NEW.id);
  RETURN NULL;
END
$$;

CREATE TRIGGER school_starts_with_result_value_scale
  AFTER INSERT ON app.school
  FOR EACH ROW EXECUTE FUNCTION app.school_starts_with_result_value_scale();

-- A version is only ever added: never changed, and never deleted but with a
-- whole expired Trial School.
GRANT SELECT, INSERT (school_id, number, saved_by_person_id) ON app.result_value_scale_version TO schoolgrid_app;
GRANT SELECT, INSERT (school_id, scale_version_id, position, label, description)
  ON app.result_value TO schoolgrid_app;

-- An expired Trial School is deleted whole (migrations/0018), its Result value
-- scale with it: the one way any version is deleted.
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
