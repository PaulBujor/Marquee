CREATE TABLE `episode_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`media_id` text NOT NULL,
	`season` integer NOT NULL,
	`episode` integer NOT NULL,
	`watched` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `episode_watches_user_media_idx` ON `episode_watches` (`user_id`,`media_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload` text NOT NULL,
	`device_id` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`client_created_at` integer NOT NULL,
	`server_received_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_user_sequence_idx` ON `events` (`user_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`tmdb_id` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`poster_path` text,
	`overview` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_tmdb_idx` ON `media` (`tmdb_id`,`type`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`last_sequence` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tracking` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`media_id` text NOT NULL,
	`status` text DEFAULT 'want_to_watch' NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`rating` integer,
	`removed` integer DEFAULT false NOT NULL,
	`status_updated_at` integer DEFAULT 0 NOT NULL,
	`favorite_updated_at` integer DEFAULT 0 NOT NULL,
	`rating_updated_at` integer DEFAULT 0 NOT NULL,
	`removed_updated_at` integer DEFAULT 0 NOT NULL,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tracking_user_status_idx` ON `tracking` (`user_id`,`status`);