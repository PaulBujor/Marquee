-- Down migration for 0004_sync_event_model.
-- Drops the event-sourced sync tables (indexes drop with their tables). None
-- reference each other (each only FKs users), so order is not significant.
DROP TABLE IF EXISTS `episode_watches`;
DROP TABLE IF EXISTS `events`;
DROP TABLE IF EXISTS `media`;
DROP TABLE IF EXISTS `sync_state`;
DROP TABLE IF EXISTS `tracking`;
