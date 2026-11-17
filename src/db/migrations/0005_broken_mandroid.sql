ALTER TABLE `admins` ADD `totp_last_step` bigint;--> statement-breakpoint
ALTER TABLE `admins` ADD `auth_version` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `admins` ADD `failed_attempts` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `admins` ADD `locked_until` datetime(3);--> statement-breakpoint
ALTER TABLE `admins` ADD `reset_token_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `admins` ADD `reset_expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `payments` ADD `admin_request_key` varchar(64);--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_admin_request_key_unique` UNIQUE(`admin_request_key`);