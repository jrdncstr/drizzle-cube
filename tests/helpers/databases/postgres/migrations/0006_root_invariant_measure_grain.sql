CREATE TABLE "root_invariant_children" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "root_invariant_children_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity_key" text NOT NULL,
	"parent_key" text NOT NULL,
	"name" text NOT NULL,
	"simple_correlation_key" text NOT NULL,
	"composite_correlation_key_a" text NOT NULL,
	"composite_correlation_key_b" text NOT NULL,
	"organisation_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "root_invariant_facts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "root_invariant_facts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity_key" text NOT NULL,
	"parent_key" text NOT NULL,
	"child_correlation_key" text NOT NULL,
	"composite_correlation_key_a" text NOT NULL,
	"composite_correlation_key_b" text NOT NULL,
	"amount" real NOT NULL,
	"organisation_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "root_invariant_parents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "root_invariant_parents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity_key" text NOT NULL,
	"name" text NOT NULL,
	"organisation_id" integer NOT NULL
);
