CREATE TABLE `episodes` (
	`media_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`air_date` text,
	`runtime` integer,
	`still_path` text,
	PRIMARY KEY(`media_id`, `season_number`, `episode_number`),
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `episodes_media_idx` ON `episodes` (`media_id`);--> statement-breakpoint
CREATE INDEX `episodes_air_date_idx` ON `episodes` (`air_date`);--> statement-breakpoint
CREATE TABLE `seasons` (
	`media_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`air_date` text,
	`poster_path` text,
	`episode_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`media_id`, `season_number`),
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `media` ADD `release_date` text;--> statement-breakpoint
ALTER TABLE `media` ADD `status` text;--> statement-breakpoint
ALTER TABLE `media` ADD `in_production` integer;--> statement-breakpoint
ALTER TABLE `media` ADD `first_air_date` text;--> statement-breakpoint
ALTER TABLE `media` ADD `last_air_date` text;--> statement-breakpoint
ALTER TABLE `media` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `media` ADD `refreshed_at` integer DEFAULT 0 NOT NULL;