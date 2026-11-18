CREATE TABLE `redirects` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source` varchar(512) NOT NULL,
	`target` varchar(512) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `redirects_id` PRIMARY KEY(`id`),
	CONSTRAINT `redirects_source_unique` UNIQUE(`source`)
);
