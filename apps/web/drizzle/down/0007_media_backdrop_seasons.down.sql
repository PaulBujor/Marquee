-- Down migration for 0007_media_backdrop_seasons.
-- Drops the header-image and season-counts columns added to `media`.
ALTER TABLE `media` DROP COLUMN `seasons`;
ALTER TABLE `media` DROP COLUMN `backdrop_path`;
