-- Down migration for 0029_media_external_ids.
-- Drops the external-id alias table (its index drops with it). Rows were derived from `media`, so
-- nothing is lost that the up migration's backfill can't rebuild.
DROP TABLE IF EXISTS `media_external_ids`;
