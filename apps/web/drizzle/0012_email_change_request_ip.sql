ALTER TABLE `email_change_tokens` ADD `request_ip` text;--> statement-breakpoint
CREATE INDEX `email_change_tokens_new_email_idx` ON `email_change_tokens` (`new_email`);--> statement-breakpoint
CREATE INDEX `email_change_tokens_request_ip_idx` ON `email_change_tokens` (`request_ip`);