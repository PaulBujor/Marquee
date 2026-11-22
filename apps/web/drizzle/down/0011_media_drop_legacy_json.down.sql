-- Down migration for 0011_media_drop_legacy_json.
-- Re-adds the legacy JSON columns dropped by the up migration (the aired frontier + season counts).
ALTER TABLE `media` ADD `last_aired` text;
ALTER TABLE `media` ADD `seasons` text;
