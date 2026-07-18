-- login_tokens is ephemeral (short-lived sign-in secrets), so recreate it
-- rather than copy — any in-flight link/code is simply re-requested.
DROP TABLE IF EXISTS `login_tokens`;--> statement-breakpoint
CREATE TABLE `login_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`request_ip` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `login_tokens_email_idx` ON `login_tokens` (`email`);--> statement-breakpoint
CREATE INDEX `login_tokens_token_hash_idx` ON `login_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `login_tokens_request_ip_idx` ON `login_tokens` (`request_ip`);