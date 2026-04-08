ALTER TABLE "tasks" ADD COLUMN "assignee_agent_key" text;--> statement-breakpoint
CREATE INDEX "tasks_room_assignee_agent_key_idx" ON "tasks" USING btree ("room_id","assignee_agent_key");--> statement-breakpoint
UPDATE "tasks" AS "t"
SET "assignee_agent_key" = "rap"."agent_key"
FROM "room_agent_presence" AS "rap"
WHERE "t"."room_id" = "rap"."room_id"
  AND "t"."assignee" = "rap"."actor_label"
  AND "t"."assignee_agent_key" IS NULL
  AND "rap"."agent_key" IS NOT NULL;
