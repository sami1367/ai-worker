CREATE TABLE IF NOT EXISTS "task_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"task_type" "task_type" NOT NULL,
	"phase" varchar(32) NOT NULL,
	"external_id" varchar(64) NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_branch" varchar(256),
	"forge_created_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_queue_items" ADD CONSTRAINT "task_queue_items_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_queue_items_repo_kind_ext_uidx" ON "task_queue_items" USING btree ("repository_id","kind","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_queue_items_repo_idx" ON "task_queue_items" USING btree ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_queue_items_phase_idx" ON "task_queue_items" USING btree ("phase");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_queue_items_synced_idx" ON "task_queue_items" USING btree ("synced_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_queue_repo_sync" (
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_queue_repo_sync" ADD CONSTRAINT "task_queue_repo_sync_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
