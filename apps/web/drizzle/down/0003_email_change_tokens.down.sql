-- Down migration for 0003_email_change_tokens.
-- Drops the email-change token table (its index drops with it).
DROP TABLE IF EXISTS `email_change_tokens`;
