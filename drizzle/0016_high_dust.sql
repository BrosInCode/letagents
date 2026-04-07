ALTER TABLE "github_room_events" ALTER COLUMN "room_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "github_room_events_idempotency_idx";--> statement-breakpoint
ALTER TABLE "github_room_events" ADD CONSTRAINT "github_room_events_idempotency_key_unique" UNIQUE("idempotency_key");