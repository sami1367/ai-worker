ALTER TABLE "task_queue_items" ADD COLUMN "assignees" jsonb DEFAULT '[]'::jsonb NOT NULL;
