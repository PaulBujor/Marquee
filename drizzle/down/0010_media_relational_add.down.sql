-- Down migration for 0010_media_relational_add.
-- Drops the seasons/episodes child tables and the columns added to `media`.
DROP TABLE `episodes`;
DROP TABLE `seasons`;
ALTER TABLE `media` DROP COLUMN `refreshed_at`;
ALTER TABLE `media` DROP COLUMN `version`;
ALTER TABLE `media` DROP COLUMN `last_air_date`;
ALTER TABLE `media` DROP COLUMN `first_air_date`;
ALTER TABLE `media` DROP COLUMN `in_production`;
ALTER TABLE `media` DROP COLUMN `status`;
ALTER TABLE `media` DROP COLUMN `release_date`;
