-- Reverse of 0025_share_preview_trailer.sql. Plain SQL (no statement-breakpoint markers), applied via
-- `wrangler d1 execute --file`. Reverses the one column the trailer is stored in; SQLite 3.35+
-- supports DROP COLUMN, and D1 is well past that.
ALTER TABLE `share_previews` DROP COLUMN `trailer`;
