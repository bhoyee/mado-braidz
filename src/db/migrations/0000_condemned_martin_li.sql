CREATE TABLE `addon_styles` (
	`addon_id` bigint unsigned NOT NULL,
	`style_id` bigint unsigned NOT NULL,
	CONSTRAINT `addon_styles_addon_id_style_id_pk` PRIMARY KEY(`addon_id`,`style_id`)
);
--> statement-breakpoint
CREATE TABLE `addons` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`description` text,
	`price_cents` int NOT NULL,
	`duration_min` int NOT NULL DEFAULT 0,
	`applies_to_all` boolean NOT NULL DEFAULT true,
	`active` boolean NOT NULL DEFAULT true,
	`sort` int NOT NULL DEFAULT 0,
	CONSTRAINT `addons_id` PRIMARY KEY(`id`),
	CONSTRAINT `addons_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `admins` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`email` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`role` enum('owner','staff') NOT NULL,
	`totp_secret` varchar(255),
	`last_login_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	CONSTRAINT `admins_id` PRIMARY KEY(`id`),
	CONSTRAINT `admins_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`admin_id` bigint unsigned NOT NULL,
	`entity` varchar(255) NOT NULL,
	`entity_id` bigint unsigned NOT NULL,
	`action` varchar(255) NOT NULL,
	`before` json,
	`after` json,
	`ip` varchar(45),
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `booking_addons` (
	`booking_id` bigint unsigned NOT NULL,
	`addon_id` bigint unsigned NOT NULL,
	`name_snapshot` varchar(255) NOT NULL,
	`price_cents` int NOT NULL,
	`duration_min` int NOT NULL,
	CONSTRAINT `booking_addons_booking_id_addon_id_pk` PRIMARY KEY(`booking_id`,`addon_id`)
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`ref` varchar(32) NOT NULL,
	`client_id` bigint unsigned NOT NULL,
	`style_id` bigint unsigned NOT NULL,
	`style_variant_id` bigint unsigned,
	`start_at` datetime(3) NOT NULL,
	`end_at` datetime(3) NOT NULL,
	`block_end_at` datetime(3) NOT NULL,
	`status` enum('pending_payment','confirmed','completed','cancelled','no_show','expired','payment_conflict') NOT NULL,
	`payment_status` enum('unpaid','deposit_paid','paid_in_full','refunded','partially_refunded') NOT NULL,
	`payment_choice` enum('deposit','full','manual','none') NOT NULL,
	`source` enum('web','admin') NOT NULL,
	`hold_expires_at` datetime(3),
	`price_snapshot` json NOT NULL,
	`subtotal_cents` int NOT NULL,
	`deposit_cents` int NOT NULL,
	`paid_cents` int NOT NULL DEFAULT 0,
	`balance_cents` int NOT NULL,
	`client_notes` text,
	`admin_notes` text,
	`inspiration_media_id` bigint unsigned,
	`manage_token_hash` varchar(64) NOT NULL,
	`policy_accepted_at` datetime(3),
	`stripe_checkout_session_id` varchar(255),
	`created_by_admin_id` bigint unsigned,
	`completed_at` datetime(3),
	`cancelled_at` datetime(3),
	`cancel_reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `bookings_id` PRIMARY KEY(`id`),
	CONSTRAINT `bookings_ref_unique` UNIQUE(`ref`)
);
--> statement-breakpoint
CREATE TABLE `calendar_locks` (
	`date` date NOT NULL,
	CONSTRAINT `calendar_locks_date` PRIMARY KEY(`date`)
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`phone_e164` varchar(32) NOT NULL,
	`marketing_consent` boolean NOT NULL DEFAULT false,
	`consent_at` datetime(3),
	`unsubscribed_at` datetime(3),
	`notes` text,
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	CONSTRAINT `clients_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`booking_id` bigint unsigned,
	`client_id` bigint unsigned,
	`template` varchar(255) NOT NULL,
	`to_email` varchar(255) NOT NULL,
	`provider_id` varchar(255),
	`status` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	CONSTRAINT `email_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`type` varchar(255) NOT NULL,
	`payload` json NOT NULL,
	`run_at` datetime(3) NOT NULL,
	`status` enum('pending','done','failed','cancelled') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` text,
	`dedupe_key` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `jobs_dedupe_key_unique` UNIQUE(`dedupe_key`)
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`style_id` bigint unsigned,
	`kind` enum('style','gallery','inspiration') NOT NULL,
	`path` varchar(1024) NOT NULL,
	`variants` json,
	`width` int,
	`height` int,
	`alt` text NOT NULL,
	`sort` int NOT NULL DEFAULT 0,
	CONSTRAINT `media_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`admin_id` bigint unsigned,
	`type` varchar(255) NOT NULL,
	`title` varchar(255) NOT NULL,
	`body` text NOT NULL,
	`url` varchar(1024),
	`read_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`booking_id` bigint unsigned NOT NULL,
	`type` enum('deposit','full','balance','refund') NOT NULL,
	`provider` enum('stripe','manual') NOT NULL,
	`method` enum('card','cash','zelle','cashapp','other') NOT NULL,
	`amount_cents` int NOT NULL,
	`stripe_payment_intent_id` varchar(255),
	`stripe_refund_id` varchar(255),
	`note` text,
	`recorded_by_admin_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`admin_id` bigint unsigned NOT NULL,
	`endpoint` varchar(512) NOT NULL,
	`keys` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	CONSTRAINT `push_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `push_subscriptions_endpoint_unique` UNIQUE(`endpoint`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` varchar(128) NOT NULL,
	`expires` int unsigned NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `sessions_session_id` PRIMARY KEY(`session_id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` varchar(64) NOT NULL,
	`value` json NOT NULL,
	`updated_by` bigint unsigned,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`id` varchar(255) NOT NULL,
	`type` varchar(255) NOT NULL,
	`received_at` datetime(3) NOT NULL,
	`processed_at` datetime(3),
	CONSTRAINT `stripe_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `style_categories` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`sort` int NOT NULL DEFAULT 0,
	CONSTRAINT `style_categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `style_categories_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `style_variants` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`style_id` bigint unsigned NOT NULL,
	`size` enum('medium','semi_medium','small'),
	`length` enum('shoulder','mid_back','waist','top_butt','butt','under_butt'),
	`label` varchar(255),
	`price_cents` int NOT NULL,
	`duration_min` int,
	`active` boolean NOT NULL DEFAULT true,
	`sort` int NOT NULL DEFAULT 0,
	CONSTRAINT `style_variants_id` PRIMARY KEY(`id`),
	CONSTRAINT `style_size_length` UNIQUE(`style_id`,`size`,`length`)
);
--> statement-breakpoint
CREATE TABLE `styles` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`category_id` bigint unsigned NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`short_desc` text,
	`long_desc` text,
	`duration_min` int NOT NULL DEFAULT 240,
	`price_on_consultation` boolean NOT NULL DEFAULT false,
	`from_price_cents` int,
	`featured` boolean NOT NULL DEFAULT false,
	`active` boolean NOT NULL DEFAULT true,
	`sort` int NOT NULL DEFAULT 0,
	`seo_title` varchar(255),
	`seo_description` text,
	`created_at` datetime(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `styles_id` PRIMARY KEY(`id`),
	CONSTRAINT `styles_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `time_blocks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`start_at` datetime(3) NOT NULL,
	`end_at` datetime(3) NOT NULL,
	`reason` text,
	`repeat_rule` varchar(255),
	`created_by` bigint unsigned NOT NULL,
	CONSTRAINT `time_blocks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `addon_styles` ADD CONSTRAINT `addon_styles_addon_id_addons_id_fk` FOREIGN KEY (`addon_id`) REFERENCES `addons`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `addon_styles` ADD CONSTRAINT `addon_styles_style_id_styles_id_fk` FOREIGN KEY (`style_id`) REFERENCES `styles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_admin_id_admins_id_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_addons` ADD CONSTRAINT `booking_addons_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_addons` ADD CONSTRAINT `booking_addons_addon_id_addons_id_fk` FOREIGN KEY (`addon_id`) REFERENCES `addons`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_client_id_clients_id_fk` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_style_id_styles_id_fk` FOREIGN KEY (`style_id`) REFERENCES `styles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_style_variant_id_style_variants_id_fk` FOREIGN KEY (`style_variant_id`) REFERENCES `style_variants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_inspiration_media_id_media_id_fk` FOREIGN KEY (`inspiration_media_id`) REFERENCES `media`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_created_by_admin_id_admins_id_fk` FOREIGN KEY (`created_by_admin_id`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_log` ADD CONSTRAINT `email_log_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_log` ADD CONSTRAINT `email_log_client_id_clients_id_fk` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media` ADD CONSTRAINT `media_style_id_styles_id_fk` FOREIGN KEY (`style_id`) REFERENCES `styles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_admin_id_admins_id_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_recorded_by_admin_id_admins_id_fk` FOREIGN KEY (`recorded_by_admin_id`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD CONSTRAINT `push_subscriptions_admin_id_admins_id_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `settings` ADD CONSTRAINT `settings_updated_by_admins_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_variants` ADD CONSTRAINT `style_variants_style_id_styles_id_fk` FOREIGN KEY (`style_id`) REFERENCES `styles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `styles` ADD CONSTRAINT `styles_category_id_style_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `style_categories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `time_blocks` ADD CONSTRAINT `time_blocks_created_by_admins_id_fk` FOREIGN KEY (`created_by`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `booking_start` ON `bookings` (`start_at`);--> statement-breakpoint
CREATE INDEX `booking_status_start` ON `bookings` (`status`,`start_at`);--> statement-breakpoint
CREATE INDEX `client_email` ON `clients` (`email`);--> statement-breakpoint
CREATE INDEX `client_phone` ON `clients` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `job_status_run` ON `jobs` (`status`,`run_at`);