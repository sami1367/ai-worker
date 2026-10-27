CREATE TYPE "public"."task_planning_status" AS ENUM('clarifying', 'ready_to_generate', 'draft', 'approved', 'created');--> statement-breakpoint
CREATE TABLE "task_planning_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"status" "task_planning_status" DEFAULT 'clarifying' NOT NULL,
	"epic_summary" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_type" varchar(32),
	"code_context_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_planning_sessions" ADD CONSTRAINT "task_planning_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_planning_sessions" ADD CONSTRAINT "task_planning_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_planning_sessions_repo_idx" ON "task_planning_sessions" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "task_planning_sessions_status_idx" ON "task_planning_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_planning_sessions_created_idx" ON "task_planning_sessions" USING btree ("created_at");
