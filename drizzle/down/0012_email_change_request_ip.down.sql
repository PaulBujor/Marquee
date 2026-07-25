-- Down migration for 0012_email_change_request_ip.
-- Drops the per-target-email + per-IP indexes and the request_ip column added by the up migration.
DROP INDEX `email_change_tokens_request_ip_idx`;
DROP INDEX `email_change_tokens_new_email_idx`;
ALTER TABLE `email_change_tokens` DROP COLUMN `request_ip`;
