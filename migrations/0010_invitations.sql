-- An Invitation: a School Administrator's offer that lets the human behind one
-- unclaimed Person attach it to a User account. The row is the whole history
-- of one offer, and is never deleted.
--
-- Nothing here records that an Invitation expired. It is pending while it is
-- neither revoked nor redeemed and its expiry is still ahead, which is decided
-- against the clock whenever it is asked. No job has to run for a lapsed link
-- to stop working, so none can fail to. Do not add an expired state.

-- For the exclusion constraint below, which compares a Person's identifier for
-- equality inside a GiST index. A trusted extension, so the schema owner needs
-- no superuser to create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE app.invitation (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                    uuid NOT NULL REFERENCES app.school (id),
  person_id                    uuid NOT NULL,
  issued_by_person_id          uuid NOT NULL,
  -- The SHA-256 of the secret. The secret is handed to the School Administrator
  -- once, inside the link, and never stored, so reading this table yields
  -- nothing that redeems.
  secret_hash                  bytea NOT NULL UNIQUE CHECK (octet_length(secret_hash) = 32),
  -- Every time on an Invitation is taken when its statement runs, not when its
  -- transaction began. A transaction that waited on a lock while another issued
  -- an Invitation began before that Invitation existed; its now() would revoke
  -- or redeem it at a time before it was created.
  created_at                   timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- Fixed platform-wide, and set by the database alone (see the grant below),
  -- so no Invitation can be issued to last longer.
  expires_at                   timestamptz NOT NULL DEFAULT statement_timestamp() + interval '7 days',
  revoked_at                   timestamptz,
  revoked_by_person_id         uuid,
  redeemed_at                  timestamptz,
  redeemed_by_user_account_id  uuid REFERENCES app.user_account (id),
  -- Every Person named belongs to the Invitation's own School (ADR-0001).
  FOREIGN KEY (school_id, person_id) REFERENCES app.person (school_id, id),
  FOREIGN KEY (school_id, issued_by_person_id) REFERENCES app.person (school_id, id),
  FOREIGN KEY (school_id, revoked_by_person_id) REFERENCES app.person (school_id, id),
  CHECK (expires_at = created_at + interval '7 days'),
  CHECK ((revoked_at IS NULL) = (revoked_by_person_id IS NULL)),
  CHECK ((redeemed_at IS NULL) = (redeemed_by_user_account_id IS NULL)),
  -- An offer ends once, one way.
  CHECK (revoked_at IS NULL OR redeemed_at IS NULL),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (redeemed_at IS NULL OR redeemed_at >= created_at),
  -- At most one pending Invitation per Person. Pending depends on the clock, so
  -- a unique index cannot say it; instead no two Invitations for one Person may
  -- be live at the same instant. Each is live from its creation until it
  -- expires, is revoked, or is redeemed, whichever comes first. One revoked as
  -- another is issued ends before the new one begins, so they do not overlap;
  -- one that has expired has stopped being live without anything being written.
  CONSTRAINT invitation_one_pending_per_person EXCLUDE USING gist (
    school_id WITH =,
    person_id WITH =,
    tstzrange(created_at, LEAST(expires_at, revoked_at, redeemed_at)) WITH &&
  ),
  -- The target of composite references from later School-scoped rows.
  UNIQUE (school_id, id)
);

CREATE INDEX invitation_school_idx ON app.invitation (school_id, created_at);

-- The application may issue an Invitation, and end it by revoking or redeeming
-- it. Who and what it was for, its secret, and when it was issued and expires
-- never change.
GRANT SELECT ON app.invitation TO schoolgrid_app;
GRANT INSERT (school_id, person_id, issued_by_person_id, secret_hash) ON app.invitation TO schoolgrid_app;
GRANT UPDATE (revoked_at, revoked_by_person_id, redeemed_at, redeemed_by_user_account_id)
  ON app.invitation TO schoolgrid_app;

-- An ended Invitation is final. The grant above lets the application end one,
-- so nothing but this stops a revoked or redeemed Invitation being reopened.
CREATE FUNCTION app.refuse_ended_invitation_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'an ended Invitation cannot change'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER invitation_end_is_final
  BEFORE UPDATE ON app.invitation
  FOR EACH ROW
  WHEN (OLD.revoked_at IS NOT NULL OR OLD.redeemed_at IS NOT NULL)
  EXECUTE FUNCTION app.refuse_ended_invitation_change();
