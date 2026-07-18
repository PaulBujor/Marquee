ALTER TABLE `users` ADD `signup_ip` text;--> statement-breakpoint
CREATE INDEX `users_signup_ip_idx` ON `users` (`signup_ip`);