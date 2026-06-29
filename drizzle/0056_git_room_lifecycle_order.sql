ALTER TABLE "rooms" ADD COLUMN IF NOT EXISTS "git_lifecycle_event_order_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rooms_git_lifecycle_order_idx" ON "rooms" USING btree ("git_lifecycle_event_order_at") WHERE "git_lifecycle_event_order_at" IS NOT NULL;
