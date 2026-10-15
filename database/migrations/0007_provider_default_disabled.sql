-- Providers must be opt-in: default off, and clear any rows that were seeded enabled.
ALTER TABLE "provider_configs" ALTER COLUMN "is_enabled" SET DEFAULT false;--> statement-breakpoint
UPDATE "provider_configs" SET "is_enabled" = false, "is_default" = false, "updated_at" = now() WHERE "is_enabled" = true;
