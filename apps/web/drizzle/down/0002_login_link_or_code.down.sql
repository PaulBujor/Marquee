-- Down migration for 0002_login_link_or_code.
-- 0002 dropped and recreated `login_tokens` with the link/code shape; this restores
-- the original 0000 shape (token_hash PK, no kind/attempts/id). login_tokens is
-- ephemeral, so recreating it just forces any in-flight link/code to be re-requested.
DROP TABLE IF EXISTS `login_tokens`;
CREATE TABLE `login_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`request_ip` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
CREATE INDEX `login_tokens_email_idx` ON `login_tokens` (`email`);
CREATE INDEX `login_tokens_request_ip_idx` ON `login_tokens` (`request_ip`);
