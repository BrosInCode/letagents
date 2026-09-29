CREATE TABLE "room_agent_work" (
  "attempt_id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL,
  "source_message_number" integer NOT NULL,
  "agent_key" text NOT NULL,
  "owner_account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "host_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "agent_instance_id" text NOT NULL,
  "publisher_revision" bigint NOT NULL,
  "summary_digest" text NOT NULL,
  "summary" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "room_agent_work_source_fk" FOREIGN KEY ("room_id", "source_message_number") REFERENCES "messages"("room_id", "number") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "room_agent_work_revision_check" CHECK ("publisher_revision" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "room_agent_work_summary_size_check" CHECK (octet_length("summary"::text) <= 2048)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "room_agent_work_delivery_uq" ON "room_agent_work" ("room_id", "source_message_number", "agent_key");
--> statement-breakpoint
CREATE INDEX "room_agent_work_recent_idx" ON "room_agent_work" ("room_id", "updated_at", "attempt_id");
