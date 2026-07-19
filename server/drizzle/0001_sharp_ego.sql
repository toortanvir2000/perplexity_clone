ALTER TABLE "users" ADD COLUMN "provider_account_id" text NOT NULL;--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_provider_account_unique" UNIQUE("provider","provider_account_id");