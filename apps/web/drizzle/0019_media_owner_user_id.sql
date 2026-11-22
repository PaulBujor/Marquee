ALTER TABLE `media` ADD `owner_user_id` text REFERENCES users(id) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `media_owner_idx` ON `media` (`owner_user_id`);
