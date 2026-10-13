CREATE TABLE IF NOT EXISTS "worker_repo_claims" (
	"lock_key" varchar(512) PRIMARY KEY NOT NULL,
	"holder" varchar(256) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"forge_type" "forge_type",
	"full_name" varchar(512),
	"task_type" varchar(64),
	"external_id" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_repo_claims_expires_idx" ON "worker_repo_claims" USING btree ("expires_at");
