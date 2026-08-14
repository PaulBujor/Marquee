CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'tmdb' NOT NULL,
	`external_id` text,
	`owner_user_id` text,
	`name` text NOT NULL,
	`profile_path` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_provider_external_idx` ON `people` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `people_owner_idx` ON `people` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `credits` (
	`media_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text NOT NULL,
	`character` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`media_id`, `person_id`, `role`),
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credits_person_idx` ON `credits` (`person_id`);
