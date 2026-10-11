CREATE TYPE "public"."connection_status" AS ENUM('pending', 'active', 'error', 'disconnected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."workspace_status" AS ENUM('not_cloned', 'queued', 'cloning', 'ready', 'syncing', 'failed', 'inaccessible');--> statement-breakpoint
CREATE TYPE "public"."workspace_operation_type" AS ENUM('clone', 'sync', 'verify', 'delete_workspace');--> statement-breakpoint
CREATE TYPE "public"."workspace_operation_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "forge_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "forge_type" NOT NULL,
	"display_name" varchar(128),
	"instance_url" text NOT NULL,
	"account_id" varchar(128) NOT NULL,
	"account_login" varchar(256),
	"account_name" varchar(256),
	"scopes" text,
	"access_token_ciphertext" text,
	"refresh_token_ciphertext" text,
	"token_expires_at" timestamp with time zone,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"last_sync_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" varchar(128) PRIMARY KEY NOT NULL,
	"provider" "forge_type" NOT NULL,
	"instance_url" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_path" varchar(512) DEFAULT '/connections' NOT NULL,
	"created_by" uuid NOT NULL,
	"connection_id" uuid,
	"display_name" varchar(128),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovered_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_repo_id" varchar(128) NOT NULL,
	"full_name" varchar(512) NOT NULL,
	"owner_login" varchar(256) NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"visibility" varchar(32) DEFAULT 'private' NOT NULL,
	"default_branch" varchar(128) DEFAULT 'main' NOT NULL,
	"clone_url_https" text NOT NULL,
	"html_url" text,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"is_fork" boolean DEFAULT false NOT NULL,
	"last_discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "discovered_repository_id" uuid;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "provider_repo_id" varchar(128);--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "instance_url" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "visibility" varchar(32);--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "workspace_status" "workspace_status" DEFAULT 'not_cloned' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "last_clone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE TABLE "workspace_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"operation_type" "workspace_operation_type" NOT NULL,
	"status" "workspace_operation_status" DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_summary" text,
	"log_excerpt" text,
	"correlation_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forge_connections" ADD CONSTRAINT "forge_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_connection_id_forge_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."forge_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_repositories" ADD CONSTRAINT "discovered_repositories_connection_id_forge_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."forge_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_connection_id_forge_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."forge_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_discovered_repository_id_discovered_repositories_id_fk" FOREIGN KEY ("discovered_repository_id") REFERENCES "public"."discovered_repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forge_connections_provider_instance_account_uidx" ON "forge_connections" USING btree ("provider","instance_url","account_id");--> statement-breakpoint
CREATE INDEX "forge_connections_provider_idx" ON "forge_connections" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "forge_connections_status_idx" ON "forge_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_repos_connection_provider_uidx" ON "discovered_repositories" USING btree ("connection_id","provider_repo_id");--> statement-breakpoint
CREATE INDEX "discovered_repos_full_name_idx" ON "discovered_repositories" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "discovered_repos_connection_idx" ON "discovered_repositories" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "repositories_connection_idx" ON "repositories" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "repositories_workspace_status_idx" ON "repositories" USING btree ("workspace_status");--> statement-breakpoint
CREATE INDEX "repositories_provider_identity_idx" ON "repositories" USING btree ("forge_type","instance_url","provider_repo_id");--> statement-breakpoint
CREATE INDEX "workspace_operations_repo_idx" ON "workspace_operations" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "workspace_operations_status_idx" ON "workspace_operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workspace_operations_created_idx" ON "workspace_operations" USING btree ("created_at");--> statement-breakpoint
-- Legacy repos with an existing local_path that is a managed workspace are marked ready when path looks populated later by health checks.
UPDATE "repositories" SET "workspace_status" = 'not_cloned' WHERE "local_path" IS NULL;
UPDATE "repositories" SET "instance_url" = CASE
  WHEN "forge_type" = 'github' THEN 'https://github.com'
  ELSE NULL
END WHERE "instance_url" IS NULL;
