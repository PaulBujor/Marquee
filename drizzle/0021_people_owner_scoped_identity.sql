DROP INDEX `people_provider_external_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `people_owner_external_idx` ON `people` (`owner_user_id`,`provider`,`external_id`) WHERE owner_user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `people_provider_external_idx` ON `people` (`provider`,`external_id`) WHERE owner_user_id is null;