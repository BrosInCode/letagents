ALTER TABLE "github_room_events" ADD COLUMN IF NOT EXISTS "semantic_id" text;--> statement-breakpoint
ALTER TABLE "github_room_events" ADD COLUMN IF NOT EXISTS "provider_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_room_events" ADD COLUMN IF NOT EXISTS "provider_object_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_room_events" ADD COLUMN IF NOT EXISTS "event_order_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_room_events" ADD COLUMN IF NOT EXISTS "ref" text;--> statement-breakpoint
ALTER TABLE "github_room_events" ADD COLUMN IF NOT EXISTS "base_ref" text;--> statement-breakpoint
ALTER TABLE "github_room_events" ADD COLUMN IF NOT EXISTS "head_ref" text;--> statement-breakpoint
ALTER TABLE "github_room_events" ADD COLUMN IF NOT EXISTS "head_sha" text;--> statement-breakpoint
UPDATE "github_room_events"
SET "event_order_at" = COALESCE("provider_event_at", "provider_object_updated_at", "created_at")
WHERE "event_order_at" IS NULL;--> statement-breakpoint
ALTER TABLE "github_room_events" ALTER COLUMN "event_order_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_room_events_room_order_idx" ON "github_room_events" USING btree ("room_id","event_order_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_room_events_room_ref_idx" ON "github_room_events" USING btree ("room_id","ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_room_events_room_head_ref_idx" ON "github_room_events" USING btree ("room_id","head_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_room_events_room_head_sha_idx" ON "github_room_events" USING btree ("room_id","head_sha");
