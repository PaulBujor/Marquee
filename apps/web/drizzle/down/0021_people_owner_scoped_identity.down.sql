-- Reverses 0021_people_owner_scoped_identity: back to one unconditional unique index on
-- (provider, external_id).
--
-- Only safe while no owned person row carries an external id. Once a user has picked a real person
-- from search, two accounts can hold rows with the same (provider, external_id), and recreating the
-- unconditional index fails. Clear those hints first if you genuinely need to roll back:
--   UPDATE people SET external_id = NULL WHERE owner_user_id IS NOT NULL;
DROP INDEX `people_owner_external_idx`;
DROP INDEX `people_provider_external_idx`;
CREATE UNIQUE INDEX `people_provider_external_idx` ON `people` (`provider`,`external_id`);
