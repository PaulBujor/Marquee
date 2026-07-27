-- Down migration for 0013_media_title_normalized.
-- Drops the case-folded search column added by the up migration.
ALTER TABLE `media` DROP COLUMN `title_normalized`;
