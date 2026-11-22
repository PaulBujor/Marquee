-- Reverse of 0023_rebuild_share_previews.sql. Plain SQL (no statement-breakpoint markers), applied
-- via `wrangler d1 execute --file`. The rebuilt table holds preview cache only, so dropping it is the
-- reverse. Recreating the table means re-applying 0022 yourself: `d1 migrations apply` has already
-- recorded it, so it will not run again on its own.
DROP INDEX IF EXISTS `share_previews_title_type_idx`;
DROP TABLE IF EXISTS `share_previews`;
