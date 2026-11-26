-- Down migration for 0032_media_unavailable_at.
-- Drops the availability marker column added by the up migration. The empty release dates it
-- normalised to NULL are not restored: NULL was the correct value for them.
ALTER TABLE `media` DROP COLUMN `unavailable_at`;
