-- Preview keys gained the media type: `tmdb:title:<id>` couldn't tell a movie from a show, so the two
-- shared one row. The type is in the row, so the stored ids can be rewritten in place. Idempotent.
UPDATE `share_previews` SET `id` = 'tmdb:' || `title_type` || ':' || `external_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `share_previews_title_type_idx`;
