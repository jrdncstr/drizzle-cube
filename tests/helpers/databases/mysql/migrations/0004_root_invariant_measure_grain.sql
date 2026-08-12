CREATE TABLE `root_invariant_children` (
	`id` int AUTO_INCREMENT NOT NULL,
	`identity_key` varchar(255) NOT NULL,
	`parent_key` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`simple_correlation_key` varchar(255) NOT NULL,
	`composite_correlation_key_a` varchar(255) NOT NULL,
	`composite_correlation_key_b` varchar(255) NOT NULL,
	`organisation_id` int NOT NULL,
	CONSTRAINT `root_invariant_children_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `root_invariant_facts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`identity_key` varchar(255) NOT NULL,
	`parent_key` varchar(255) NOT NULL,
	`child_correlation_key` varchar(255) NOT NULL,
	`composite_correlation_key_a` varchar(255) NOT NULL,
	`composite_correlation_key_b` varchar(255) NOT NULL,
	`amount` decimal(10,2) NOT NULL,
	`organisation_id` int NOT NULL,
	CONSTRAINT `root_invariant_facts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `root_invariant_parents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`identity_key` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`organisation_id` int NOT NULL,
	CONSTRAINT `root_invariant_parents_id` PRIMARY KEY(`id`)
);
