-- Reverse of 0024_rekey_share_previews.sql. Plain SQL (no statement-breakpoint markers), applied via
-- `wrangler d1 execute --file`. The old key can't distinguish a movie from a show: this restores what
-- the previous code read. Pair it with re-applying 0023 if you need the old table shape too.
UPDATE `share_previews` SET `id` = 'tmdb:title:' || `external_id`;
CREATE INDEX IF NOT EXISTS `share_previews_title_type_idx` ON `share_previews` (`title_type`);
