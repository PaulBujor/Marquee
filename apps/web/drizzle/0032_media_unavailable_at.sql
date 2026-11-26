ALTER TABLE `media` ADD `unavailable_at` integer;--> statement-breakpoint
--> Legacy data fix: an empty release date fails every `IS NULL` predicate and compares as a past date,
--> so those titles read as permanently released and are never refreshed again. NULL is the real "no date".
UPDATE `media` SET `release_date` = NULL WHERE `release_date` = '';
