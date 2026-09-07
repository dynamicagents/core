CREATE TABLE `round_observations` (
	`task_id` text NOT NULL,
	`round` integer NOT NULL,
	`messages_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `round`)
);
--> statement-breakpoint
CREATE INDEX `idx_round_observations_created_at` ON `round_observations` (`created_at`);