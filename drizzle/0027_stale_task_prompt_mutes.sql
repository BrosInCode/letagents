CREATE TABLE "stale_task_prompt_mutes" (
  "room_id" text NOT NULL REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "task_id" text NOT NULL,
  "task_updated_at" timestamp with time zone NOT NULL,
  "muted_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "stale_task_prompt_mutes_pk" PRIMARY KEY ("room_id", "task_id")
);

CREATE INDEX "stale_task_prompt_mutes_room_idx"
  ON "stale_task_prompt_mutes" ("room_id", "updated_at");
