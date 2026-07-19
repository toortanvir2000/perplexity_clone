ALTER TYPE "public"."auth_provider" ADD VALUE IF NOT EXISTS 'Local';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;