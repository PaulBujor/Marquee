-- Down migration for 0001_waitlist_signup_ip.
-- Drops the signup-IP column and its index (index first, then the column).
DROP INDEX IF EXISTS `users_signup_ip_idx`;
ALTER TABLE `users` DROP COLUMN `signup_ip`;
