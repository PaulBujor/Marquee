CREATE INDEX `episodes_media_air_date_idx` ON `episodes` (`media_id`,`air_date`);--> statement-breakpoint
CREATE INDEX `login_tokens_expires_at_idx` ON `login_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `login_tokens_consumed_at_idx` ON `login_tokens` (`consumed_at`);--> statement-breakpoint
CREATE INDEX `media_type_in_production_idx` ON `media` (`type`,`in_production`);--> statement-breakpoint
CREATE INDEX `media_type_release_date_idx` ON `media` (`type`,`release_date`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);