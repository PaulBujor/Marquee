-- Down migration for 0000_init_auth.
-- Reverses the initial auth schema. Drop children (FK → users) before users.
DROP TRIGGER IF EXISTS `users_set_updated_at`;
DROP TABLE IF EXISTS `sessions`;
DROP TABLE IF EXISTS `login_tokens`;
DROP TABLE IF EXISTS `users`;
