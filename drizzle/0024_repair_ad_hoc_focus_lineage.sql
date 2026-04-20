ALTER TABLE "rooms" DROP CONSTRAINT IF EXISTS "rooms_focus_lineage_check";--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_focus_lineage_check" CHECK ((
	"rooms"."kind" = 'main'
	AND "rooms"."parent_room_id" IS NULL
	AND "rooms"."focus_key" IS NULL
	AND "rooms"."source_task_id" IS NULL
	AND "rooms"."focus_status" IS NULL
	AND "rooms"."concluded_at" IS NULL
	AND "rooms"."conclusion_summary" IS NULL
) OR (
	"rooms"."kind" = 'focus'
	AND "rooms"."parent_room_id" IS NOT NULL
	AND "rooms"."focus_key" IS NOT NULL
	AND "rooms"."focus_status" IS NOT NULL
));
