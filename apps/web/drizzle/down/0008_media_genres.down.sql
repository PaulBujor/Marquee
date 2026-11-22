-- Down migration for 0008_media_genres.
ALTER TABLE `media` DROP COLUMN `genres`;
