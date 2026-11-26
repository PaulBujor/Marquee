ALTER TABLE `events` ADD `origin` text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `api_token_id` text REFERENCES api_tokens(id) ON DELETE SET NULL;
