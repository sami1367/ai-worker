ALTER TABLE "worker_state" ADD COLUMN IF NOT EXISTS "active_tasks" jsonb DEFAULT '[]'::jsonb NOT NULL;
