-- A School owns everything beneath it (ADR-0001). Every School-scoped table
-- carries its own non-null school_id, and every reference from one such row to
-- another is a composite foreign key that includes school_id. That makes a row
-- referencing two Schools unrepresentable rather than merely unlikely.

CREATE TABLE app.school (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (name <> ''),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A Person exists within exactly one School. The same human at two Schools is
-- two rows with nothing linking them; all they may share is the User account
-- that resolves to each, and that account holds no authorization.
CREATE TABLE app.person (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES app.school (id),
  user_account_id  uuid REFERENCES app.user_account (id),
  display_name     text NOT NULL CHECK (display_name <> ''),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- The target of the composite references from School-scoped rows.
  UNIQUE (school_id, id),
  -- An account resolves to at most one Person per School.
  UNIQUE (school_id, user_account_id)
);

CREATE INDEX person_user_account_id_idx ON app.person (user_account_id);

-- One row per role. Ticket 06 adds the remaining roles and each membership's
-- bounds; only what bootstrapping a School needs exists yet.
CREATE TABLE app.school_membership (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES app.school (id),
  person_id   uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('school_administrator')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, person_id) REFERENCES app.person (school_id, id)
);

CREATE INDEX school_membership_person_idx ON app.school_membership (school_id, person_id);
