ALTER TABLE "rooms" ADD COLUMN "kind" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "parent_room_id" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "focus_key" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "source_task_id" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "focus_status" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "concluded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "conclusion_summary" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_parent_room_id_rooms_id_fk" FOREIGN KEY ("parent_room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_kind_check" CHECK ("rooms"."kind" IN ('main', 'focus'));--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_focus_status_check" CHECK ("rooms"."focus_status" IS NULL OR "rooms"."focus_status" IN ('active', 'concluded'));--> statement-breakpoint
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
	AND "rooms"."source_task_id" IS NOT NULL
	AND "rooms"."focus_status" IS NOT NULL
));--> statement-breakpoint
CREATE INDEX "rooms_parent_room_id_idx" ON "rooms" USING btree ("parent_room_id");--> statement-breakpoint
CREATE INDEX "rooms_parent_source_task_idx" ON "rooms" USING btree ("parent_room_id","source_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_parent_focus_key_idx" ON "rooms" USING btree ("parent_room_id","focus_key") WHERE "rooms"."kind" = 'focus';--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_active_focus_task_idx" ON "rooms" USING btree ("parent_room_id","source_task_id") WHERE "rooms"."kind" = 'focus' AND "rooms"."focus_status" = 'active';
