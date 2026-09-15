-- A User account is credentials and authentication state, and nothing else.
-- It carries no School reference, role, or permission: those belong to the
-- Person an account resolves to within a School, which is a separate concern.

CREATE TABLE app.user_account (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text NOT NULL CHECK (username <> ''),
  -- A self-describing scrypt hash. The password itself is never stored.
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Usernames differ by more than case, so `Alice` and `alice` cannot be two
-- accounts that a person would read as the same.
CREATE UNIQUE INDEX user_account_username_key ON app.user_account (lower(username));

CREATE TABLE app.user_session (
  -- The SHA-256 of the bearer token. The token is handed to the caller once
  -- and never stored, so reading this table yields nothing a caller can present.
  token_hash       bytea PRIMARY KEY,
  user_account_id  uuid NOT NULL REFERENCES app.user_account (id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);

CREATE INDEX user_session_user_account_id_idx ON app.user_session (user_account_id);
