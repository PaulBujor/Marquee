ALTER TABLE `passkey_challenges` ADD `rp_id` text;--> statement-breakpoint
ALTER TABLE `passkey_challenges` ADD `request_ip` text;--> statement-breakpoint
CREATE INDEX `passkey_challenges_request_ip_idx` ON `passkey_challenges` (`request_ip`);