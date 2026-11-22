-- Down migration for 0005_media_provider_columns.
-- Reverses the provider-agnostic identity columns added to `media`: drops the
-- (provider, external_id) unique index and the three columns it introduced.
DROP INDEX IF EXISTS `media_provider_external_idx`;
ALTER TABLE `media` DROP COLUMN `source`;
ALTER TABLE `media` DROP COLUMN `external_id`;
ALTER TABLE `media` DROP COLUMN `provider`;
