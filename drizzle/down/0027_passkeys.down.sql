DROP INDEX IF EXISTS `passkeys_user_id_idx`;
DROP INDEX IF EXISTS `passkeys_credential_id_unique`;
DROP TABLE IF EXISTS `passkeys`;
DROP INDEX IF EXISTS `passkey_challenges_expires_at_idx`;
DROP TABLE IF EXISTS `passkey_challenges`;
