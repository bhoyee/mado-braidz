CREATE TABLE `email_suppressions` (
	`email` varchar(255) NOT NULL,
	`reason` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `email_suppressions_email` PRIMARY KEY(`email`)
);
