ALTER TYPE "public"."auth_provider" ADD VALUE IF NOT EXISTS 'Local';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;