ALTER TABLE "users" ADD COLUMN "email" varchar(320);--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "codegraph_enabled" boolean DEFAULT true NOT NULL;
