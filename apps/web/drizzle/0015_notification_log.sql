CREATE TABLE `notification_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_log_user_id_idx` ON `notification_log` (`user_id`);