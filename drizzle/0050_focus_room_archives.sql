ALTER TABLE "rooms" ADD COLUMN "focus_archived_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX IF EXISTS "rooms_parent_focus_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_parent_focus_key_idx" ON "rooms" USING btree ("parent_room_id","focus_key") WHERE "rooms"."kind" = 'focus' AND "rooms"."focus_archived_at" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "rooms_active_focus_task_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_active_focus_task_idx" ON "rooms" USING btree ("parent_room_id","source_task_id") WHERE "rooms"."kind" = 'focus' AND "rooms"."focus_status" = 'active' AND "rooms"."focus_archived_at" IS NULL;
