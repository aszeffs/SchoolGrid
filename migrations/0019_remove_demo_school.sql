-- The shared demo's School, which Trial Schools replace (ADR-0012), deleted
-- once from the database that held it: production, seeded from the retired
-- demo/seed.sql under this fixed identifier. Anywhere it never ran, this finds
-- nothing and deletes nothing.
--
-- Deleted the one way a School may be: made a Trial School past its expiry and
-- handed to the function of migrations/0018, so its Audit records go with it
-- and no other School can. Its accounts first count as created in it, as a
-- Trial School's do: the four whose passwords the demo published, and any a
-- visitor made there by redeeming an Invitation. The function keeps any of
-- them that belongs to another School too.

UPDATE app.user_account account
SET created_in_school_id = '5c4001a0-0000-4000-8000-000000000001'
WHERE created_in_school_id IS NULL
  AND (
    EXISTS (
      SELECT 1 FROM app.person
      WHERE user_account_id = account.id AND school_id = '5c4001a0-0000-4000-8000-000000000001'
    )
    OR EXISTS (
      SELECT 1 FROM app.invitation
      WHERE redeemed_by_user_account_id = account.id AND school_id = '5c4001a0-0000-4000-8000-000000000001'
    )
  );

UPDATE app.school SET trial_expires_at = now() WHERE id = '5c4001a0-0000-4000-8000-000000000001';

SELECT app.delete_expired_trial_school('5c4001a0-0000-4000-8000-000000000001');
