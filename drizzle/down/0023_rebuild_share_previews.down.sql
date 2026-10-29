-- Reverse of 0023_rebuild_share_previews.sql. Plain SQL (no statement-breakpoint markers), applied
-- via `wrangler d1 execute --file`. The rebuilt table holds preview cache only, so dropping it is
-- the reverse; 0022 recreates the shape the current code expects.
DROP INDEX IF EXISTS `share_previews_title_type_idx`;
DROP TABLE IF EXISTS `share_previews`;
