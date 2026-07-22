ALTER TABLE `media` ADD `provider` text DEFAULT 'tmdb' NOT NULL;--> statement-breakpoint
ALTER TABLE `media` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `media` ADD `source` text DEFAULT 'linked' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `media_provider_external_idx` ON `media` (`provider`,`external_id`);