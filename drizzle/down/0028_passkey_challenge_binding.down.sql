DROP INDEX IF EXISTS `passkey_challenges_request_ip_idx`;
ALTER TABLE `passkey_challenges` DROP COLUMN `request_ip`;
ALTER TABLE `passkey_challenges` DROP COLUMN `rp_id`;
