-- Every application object lives in the `app` schema rather than `public`.
-- Keeping them out of `public` is what makes ticket 04's append-only audit
-- grants expressible: privileges can be revoked per schema without fighting
-- the defaults Postgres attaches to `public`.

CREATE SCHEMA IF NOT EXISTS app;
