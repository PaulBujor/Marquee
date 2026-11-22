-- Down migration for 0015_notification_log.
-- Drops the sent-notification ledger (its index drops with it).
DROP TABLE IF EXISTS `notification_log`;
