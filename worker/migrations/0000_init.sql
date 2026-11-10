CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`receipt_id` text,
	`attempt` integer NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`input_mode` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`neurons_est` real,
	`latency_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_ai_usage_created` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_user_created` ON `ai_usage` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_receipt` ON `ai_usage` (`receipt_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_id_slug_unique` ON `categories` (`user_id`,`slug`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`receipt_id` text,
	`category_id` text NOT NULL,
	`merchant` text NOT NULL,
	`txn_date` text NOT NULL,
	`txn_time` text,
	`currency` text NOT NULL,
	`total_minor` integer NOT NULL,
	`tax_minor` integer,
	`payment_method` text,
	`line_items` text,
	`confidence` real,
	`source` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entries_receipt_id_unique` ON `ledger_entries` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `idx_ledger_user_cat_date` ON `ledger_entries` (`user_id`,`category_id`,`txn_date`);--> statement-breakpoint
CREATE INDEX `idx_ledger_user_date` ON `ledger_entries` (`user_id`,`txn_date`,`txn_time`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`drive_file_id` text,
	`drive_link` text,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`raw_extraction` text,
	`retry_after` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_receipts_user_status` ON `receipts` (`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_user_id_sha256_unique` ON `receipts` (`user_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`default_currency` text DEFAULT 'SGD' NOT NULL,
	`drive_folder_id` text,
	`refresh_token_enc` text,
	`drive_status` text DEFAULT 'connected' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);