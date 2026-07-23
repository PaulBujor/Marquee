-- Down migration for 0009_media_last_aired.
ALTER TABLE `media` DROP COLUMN `last_aired`;
