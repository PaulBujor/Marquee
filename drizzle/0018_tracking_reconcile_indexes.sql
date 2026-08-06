CREATE INDEX `episode_watches_media_id_idx` ON `episode_watches` (`media_id`);--> statement-breakpoint
CREATE INDEX `tracking_media_status_idx` ON `tracking` (`media_id`,`status`);