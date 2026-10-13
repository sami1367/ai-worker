CREATE TYPE "public"."prompt_kind" AS ENUM('template', 'snippet');--> statement-breakpoint
CREATE TABLE "prompt_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" varchar(256) NOT NULL,
	"kind" "prompt_kind" NOT NULL,
	"task_type" "task_type",
	"display_name" varchar(128) NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"content_version" integer DEFAULT 1 NOT NULL,
	"seed_checksum" varchar(64),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_templates_path_uidx" ON "prompt_templates" USING btree ("path");--> statement-breakpoint
CREATE INDEX "prompt_templates_kind_idx" ON "prompt_templates" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "prompt_templates_task_type_idx" ON "prompt_templates" USING btree ("task_type");
