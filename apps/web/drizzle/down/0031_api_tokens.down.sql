-- Down migration for 0031_api_tokens.
-- Drops the external API credential table (its indexes drop with it).
DROP TABLE IF EXISTS `api_tokens`;
