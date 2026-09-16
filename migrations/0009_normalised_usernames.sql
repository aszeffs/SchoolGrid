-- A username is unique regardless of how it is spelled, not only of its letter
-- case. `lower()` left look-alikes distinct: a precomposed `é` and `e` with a
-- combining accent, the ligature `ﬁ` and `fi`, full-width `ａｌｉｃｅ` and
-- `alice`, and, under the C locale, `É` and `é`. Once a person can choose their
-- own username, each of those is a way to pass as someone else.

-- The one definition of when two usernames are the same: NFKC, then full
-- case-folding, then NFKC again, since folding can leave a string that is no
-- longer normalised. Folding uses the builtin `pg_unicode_fast` collation so
-- the result does not depend on the cluster's locale. The username is stored
-- as it was entered; this key is what uniqueness and sign-in compare.
CREATE FUNCTION app.username_key(username text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN normalize(casefold(normalize(username, NFKC) COLLATE pg_unicode_fast), NFKC);

-- Accounts that are distinct today but the same under the new rule are not
-- merged: which one is the real person is not the migration's to decide.
DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(usernames, '; ')
  INTO collisions
  FROM (
    SELECT string_agg(quote_literal(username), ', ' ORDER BY username) AS usernames
    FROM app.user_account
    GROUP BY app.username_key(username)
    HAVING count(*) > 1
  ) look_alikes;

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'User accounts collide once usernames are normalised; rename them before migrating: %',
      collisions;
  END IF;
END
$$;

DROP INDEX app.user_account_username_key;
CREATE UNIQUE INDEX user_account_username_key ON app.user_account (app.username_key(username));
