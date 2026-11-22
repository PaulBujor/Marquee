-- An in-flight revision of 0022 was applied in the `preview` environment before the migration was
-- regenerated, so its `share_previews` table carries legacy NOT NULL columns that the current code
-- never fills — reads work (they name only current columns) while every warm fails on the insert.
-- The table holds regenerable preview cache, never user data, so rebuild it rather than guess at a
-- column list. Environments that applied the current 0022 are unaffected: the shape below is its.
DROP TABLE IF EXISTS `share_previews`;--> statement-breakpoint
CREATE TABLE `share_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'tmdb' NOT NULL,
	`external_id` text NOT NULL,
	`title_type` text NOT NULL,
	`name` text NOT NULL,
	`year` integer,
	`summary` text,
	`image_path` text,
	`backdrop_path` text,
	`rating` real,
	`runtime` integer,
	`released_on` text,
	`seasons` integer,
	`production` text,
	`genres` text,
	`crew` text,
	`cast` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `share_previews_title_type_idx` ON `share_previews` (`title_type`);
