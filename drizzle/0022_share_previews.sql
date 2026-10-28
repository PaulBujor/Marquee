CREATE TABLE `share_preview_warms` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_preview_warms_user_created_idx` ON `share_preview_warms` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `share_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`provider` text DEFAULT 'tmdb' NOT NULL,
	`external_id` text NOT NULL,
	`title_type` text,
	`name` text NOT NULL,
	`year` integer,
	`summary` text,
	`image_path` text,
	`known_for` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `share_previews_kind_idx` ON `share_previews` (`kind`);