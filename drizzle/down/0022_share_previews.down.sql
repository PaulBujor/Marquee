-- Reverse of 0022_share_previews.sql. Plain SQL (no statement-breakpoint markers), applied via
-- `wrangler d1 execute --file`.
DROP INDEX IF EXISTS `share_previews_kind_idx`;
DROP TABLE IF EXISTS `share_previews`;
DROP INDEX IF EXISTS `share_preview_warms_user_created_idx`;
DROP TABLE IF EXISTS `share_preview_warms`;
