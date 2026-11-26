-- Down migration for 0033_event_origin.
-- Drops the write-path attribution columns. The events themselves stay: only the record of which
-- surface (and which API token) wrote them is lost.
ALTER TABLE `events` DROP COLUMN `api_token_id`;
ALTER TABLE `events` DROP COLUMN `origin`;
