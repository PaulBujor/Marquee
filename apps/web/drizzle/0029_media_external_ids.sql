CREATE TABLE `media_external_ids` (
	`media_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	PRIMARY KEY(`media_id`, `provider`),
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_external_ids_provider_external_idx` ON `media_external_ids` (`provider`,`external_id`);--> statement-breakpoint
-- Primary alias backfill: a title's own provider id is what hydration and refresh resolve
-- through, so seed it before any link can point elsewhere. Idempotent so re-running is a no-op.
INSERT OR IGNORE INTO `media_external_ids` (`media_id`, `provider`, `external_id`)
SELECT `id`, `provider`, `external_id` FROM `media` WHERE `external_id` IS NOT NULL;
