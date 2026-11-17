CREATE TABLE `payment_proofs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`booking_id` bigint unsigned NOT NULL,
	`method` enum('zelle','cashapp') NOT NULL,
	`payment_type` enum('deposit','full','balance') NOT NULL,
	`amount_cents` int NOT NULL,
	`path` varchar(1024) NOT NULL,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`reviewed_by` bigint unsigned,
	`reviewed_at` datetime(3),
	`review_note` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_proofs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `payment_proofs` ADD CONSTRAINT `payment_proofs_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_proofs` ADD CONSTRAINT `payment_proofs_reviewed_by_admins_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;