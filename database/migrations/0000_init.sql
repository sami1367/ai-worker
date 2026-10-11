CREATE TYPE "public"."control_action" AS ENUM('reload_config', 'start', 'stop', 'restart');--> statement-breakpoint
CREATE TYPE "public"."control_status" AS ENUM('pending', 'acknowledged', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."forge_type" AS ENUM('github', 'gitlab');--> statement-breakpoint
CREATE TYPE "public"."health_status" AS ENUM('unknown', 'healthy', 'degraded', 'unhealthy');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('github_issue', 'gitlab_issue', 'github_pr_implement', 'gitlab_mr_implement', 'github_pr_review', 'gitlab_mr_review', 'release');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'operator');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('unknown', 'starting', 'running', 'stopping', 'stopped', 'error');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_username" varchar(64),
	"action" varchar(128) NOT NULL,
	"target_type" varchar(64),
	"target_id" varchar(128),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "control_action" NOT NULL,
	"status" "control_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"ip_hash" varchar(64) NOT NULL,
	"succeeded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_type" varchar(32) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ciphertext" text,
	"last_health_check_at" timestamp with time zone,
	"health_status" "health_status" DEFAULT 'unknown' NOT NULL,
	"health_message" text,
	"detected_version" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(128) NOT NULL,
	"forge_type" "forge_type" NOT NULL,
	"remote_url" text NOT NULL,
	"canonical_project_identifier" varchar(256),
	"workspace_id" varchar(64) NOT NULL,
	"local_path" text,
	"default_branch" varchar(128) DEFAULT 'main' NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"block_on_open_pr" boolean DEFAULT true NOT NULL,
	"default_ai_provider" varchar(32),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"health_status" "health_status" DEFAULT 'unknown' NOT NULL,
	"health_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" varchar(64),
	"user_agent" varchar(512)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid,
	"forge_type" "forge_type" NOT NULL,
	"task_type" "task_type" NOT NULL,
	"external_id" varchar(64) NOT NULL,
	"external_url" text,
	"title" text,
	"provider" varchar(32),
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"exit_code" integer,
	"error_summary" text,
	"result_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"log_path" text,
	"log_expired" boolean DEFAULT false NOT NULL,
	"correlation_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'admin' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"worker_status" "worker_status",
	"message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"status" "worker_status" DEFAULT 'unknown' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_poll_at" timestamp with time zone,
	"last_successful_poll_at" timestamp with time zone,
	"config_version_loaded" integer,
	"hostname" varchar(256),
	"pid" integer,
	"version" varchar(64),
	"provider_availability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_task_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_requests" ADD CONSTRAINT "control_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "control_requests_status_idx" ON "control_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "control_requests_created_idx" ON "control_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_username_created_idx" ON "login_attempts" USING btree ("username","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_created_idx" ON "login_attempts" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_configs_type_uidx" ON "provider_configs" USING btree ("provider_type");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_name_forge_uidx" ON "repositories" USING btree ("name","forge_type");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_workspace_uidx" ON "repositories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "repositories_enabled_idx" ON "repositories" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "repositories_forge_idx" ON "repositories" USING btree ("forge_type");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "task_runs_repo_idx" ON "task_runs" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "task_runs_status_idx" ON "task_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_runs_started_idx" ON "task_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "task_runs_correlation_idx" ON "task_runs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "task_runs_external_idx" ON "task_runs" USING btree ("task_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uidx" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "worker_events_created_idx" ON "worker_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "worker_events_type_idx" ON "worker_events" USING btree ("event_type");