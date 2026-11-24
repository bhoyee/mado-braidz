CREATE TABLE `notification_reads` (
	`notification_id` bigint unsigned NOT NULL,
	`admin_id` bigint unsigned NOT NULL,
	`read_at` datetime(3) NOT NULL,
	CONSTRAINT `notification_reads_notification_id_admin_id_pk` PRIMARY KEY(`notification_id`,`admin_id`)
);
--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `label` varchar(80);--> statement-breakpoint
ALTER TABLE `notification_reads` ADD CONSTRAINT `notification_reads_notification_id_notifications_id_fk` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_reads` ADD CONSTRAINT `notification_reads_admin_id_admins_id_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;