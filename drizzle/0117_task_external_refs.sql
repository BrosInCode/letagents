-- Additive: older servers never read these. A card can name one external ticket per room.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "external_ref" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "ticket_state" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "external_item_id" text;
--> statement-breakpoint
-- No existing row has an external_ref, so the build reads only an empty partial set.
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_room_external_ref_unique_idx" ON "tasks" USING btree ("room_id", "external_ref") WHERE "external_ref" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_mentions" (
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"task_number" integer NOT NULL,
	"message_number" integer NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_mentions_pk" PRIMARY KEY ("room_id", "task_number", "message_number"),
	CONSTRAINT "task_mentions_task_fk" FOREIGN KEY ("room_id", "task_number") REFERENCES "tasks"("room_id", "number") ON DELETE CASCADE ON UPDATE CASCADE,
	CONSTRAINT "task_mentions_message_fk" FOREIGN KEY ("room_id", "message_number") REFERENCES "messages"("room_id", "number") ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_mentions_message_idx" ON "task_mentions" USING btree ("room_id", "message_number");
