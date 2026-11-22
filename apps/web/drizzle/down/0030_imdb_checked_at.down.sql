-- Down migration for 0030_imdb_checked_at.
-- Drops the IMDb backfill marker column added by the up migration.
ALTER TABLE `media` DROP COLUMN `imdb_checked_at`;
