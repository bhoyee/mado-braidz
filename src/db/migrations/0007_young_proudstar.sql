ALTER TABLE `email_log` ADD `delivery_key` varchar(255);--> statement-breakpoint
ALTER TABLE `email_log` ADD CONSTRAINT `email_log_delivery_key_unique` UNIQUE(`delivery_key`);