CREATE TABLE `checkout_attempts` (
	`id` varchar(100) NOT NULL,
	`booking_id` bigint unsigned NOT NULL,
	`payment_type` enum('deposit','full','balance') NOT NULL,
	`amount_cents` int NOT NULL,
	`status` enum('creating','open','paid','expired') NOT NULL,
	`stripe_session_id` varchar(255),
	`stripe_payment_intent_id` varchar(255),
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `checkout_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `checkout_attempts_stripe_session_id_unique` UNIQUE(`stripe_session_id`),
	CONSTRAINT `checkout_attempts_stripe_payment_intent_id_unique` UNIQUE(`stripe_payment_intent_id`)
);
--> statement-breakpoint
ALTER TABLE `bookings` ADD `checkout_request_key` varchar(64);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_checkout_request_key_unique` UNIQUE(`checkout_request_key`);--> statement-breakpoint
ALTER TABLE `checkout_attempts` ADD CONSTRAINT `checkout_attempts_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;