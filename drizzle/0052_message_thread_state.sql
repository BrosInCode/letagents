ALTER TABLE "messages" ADD COLUMN "thread_root_number" integer;

WITH RECURSIVE "reply_chain" AS (
  SELECT
    "room_id",
    "number",
    "reply_to_number" AS "ancestor_number",
    1 AS "depth"
  FROM "messages"
  WHERE "reply_to_number" IS NOT NULL

  UNION ALL

  SELECT
    "reply_chain"."room_id",
    "reply_chain"."number",
    "parent"."reply_to_number" AS "ancestor_number",
    "reply_chain"."depth" + 1 AS "depth"
  FROM "reply_chain"
  INNER JOIN "messages" AS "parent"
    ON "parent"."room_id" = "reply_chain"."room_id"
   AND "parent"."number" = "reply_chain"."ancestor_number"
  WHERE "parent"."reply_to_number" IS NOT NULL
    AND "reply_chain"."depth" < 100
),
"thread_roots" AS (
  SELECT DISTINCT ON ("room_id", "number")
    "room_id",
    "number",
    "ancestor_number" AS "thread_root_number"
  FROM "reply_chain"
  ORDER BY "room_id", "number", "depth" DESC
)
UPDATE "messages"
SET "thread_root_number" = "thread_roots"."thread_root_number"
FROM "thread_roots"
WHERE "messages"."room_id" = "thread_roots"."room_id"
  AND "messages"."number" = "thread_roots"."number"
  AND "thread_roots"."thread_root_number" IS NOT NULL;

CREATE INDEX "messages_thread_root_idx" ON "messages" ("room_id", "thread_root_number");

CREATE TABLE "message_thread_reads" (
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "thread_root_number" integer NOT NULL,
  "account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE cascade,
  "last_read_message_number" integer NOT NULL,
  "read_at" timestamp with time zone NOT NULL,
  CONSTRAINT "message_thread_reads_pk" PRIMARY KEY ("room_id", "thread_root_number", "account_id")
);

CREATE INDEX "message_thread_reads_account_idx" ON "message_thread_reads" ("account_id");
CREATE INDEX "message_thread_reads_room_account_idx" ON "message_thread_reads" ("room_id", "account_id");
CREATE INDEX "message_thread_reads_thread_root_idx" ON "message_thread_reads" ("room_id", "thread_root_number");
