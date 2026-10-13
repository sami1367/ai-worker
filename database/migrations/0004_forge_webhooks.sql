ALTER TABLE "forge_connections" ADD COLUMN IF NOT EXISTS "webhook_secret_ciphertext" text;
