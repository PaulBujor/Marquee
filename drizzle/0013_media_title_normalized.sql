ALTER TABLE `media` ADD `title_normalized` text DEFAULT '' NOT NULL;--> statement-breakpoint
--> Backfill existing rows. SQLite `lower()` folds ASCII only; non-ASCII titles get their exact
--> full-Unicode fold on the next TMDB re-hydrate (refreshMedia), matching the offline client (MRQ-141).
UPDATE `media` SET `title_normalized` = lower(`title`);
