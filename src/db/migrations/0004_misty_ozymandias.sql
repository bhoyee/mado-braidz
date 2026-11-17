CREATE TABLE `payment_batches` (
	`id` varchar(64) NOT NULL,
	`items` json NOT NULL,
	`total_cents` int NOT NULL,
	`status` enum('creating','open','paid','expired') NOT NULL,
	`stripe_session_id` varchar(255),
	`stripe_payment_intent_id` varchar(255),
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_batches_stripe_session_id_unique` UNIQUE(`stripe_session_id`),
	CONSTRAINT `payment_batches_stripe_payment_intent_id_unique` UNIQUE(`stripe_payment_intent_id`)
);
--> statement-breakpoint
ALTER TABLE `checkout_attempts` ADD `batch_id` varchar(64);