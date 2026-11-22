-- Down migration for 0020_media_credits.
-- Child before parent: `credits` holds the FK into `people`.
DROP TABLE IF EXISTS `credits`;
DROP TABLE IF EXISTS `people`;
