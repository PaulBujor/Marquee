-- Down migration for 0014_push_subscriptions.
-- Drops the Web Push subscription table (its indexes drop with it).
DROP TABLE IF EXISTS `push_subscriptions`;
