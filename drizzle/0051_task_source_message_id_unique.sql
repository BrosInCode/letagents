WITH duplicate_sources AS (
  SELECT
    "room_id",
    "number",
    "source_message_id",
    ROW_NUMBER() OVER (
      PARTITION BY "room_id", "source_message_id"
      ORDER BY "number" ASC
    ) AS duplicate_rank
  FROM "tasks"
  WHERE "source_message_id" IS NOT NULL
)
UPDATE "tasks"
SET "source_message_id" = "tasks"."source_message_id" || ':duplicate:' || "tasks"."number"
FROM duplicate_sources
WHERE "tasks"."room_id" = duplicate_sources."room_id"
  AND "tasks"."number" = duplicate_sources."number"
  AND duplicate_sources.duplicate_rank > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_room_source_message_id_unique_idx" ON "tasks" USING btree ("room_id","source_message_id") WHERE "tasks"."source_message_id" IS NOT NULL;
