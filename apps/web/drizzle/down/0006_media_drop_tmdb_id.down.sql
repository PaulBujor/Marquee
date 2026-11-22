-- Down migration for 0006_media_drop_tmdb_id.
-- Restores the dropped `tmdb_id` column and its unique index. SQLite cannot add a
-- NOT NULL column without a default, so this reversal uses DEFAULT 0 (the original
-- 0004 column had no default); the `media` table is an empty display cache, so no
-- real row is affected by the differing default.
ALTER TABLE `media` ADD COLUMN `tmdb_id` integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX `media_tmdb_idx` ON `media` (`tmdb_id`,`type`);
