-- Down migration for 0019_media_owner_user_id.
-- Drop the index first: SQLite refuses to drop a column an index still refers to.
DROP INDEX IF EXISTS `media_owner_idx`;
ALTER TABLE `media` DROP COLUMN `owner_user_id`;
