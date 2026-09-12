CREATE TABLE `human_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`round` integer NOT NULL,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`answer_json` text,
	`answer_message_id` text,
	`parked_at` integer,
	`closed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_human_requests_task_round` ON `human_requests` (`task_id`,`round`);--> statement-breakpoint
CREATE INDEX `idx_human_requests_created_at` ON `human_requests` (`created_at`);