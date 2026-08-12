ALTER TABLE "messages" ADD COLUMN "publisher_account_id" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "routing_snapshot_version" integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_agent_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "message_room_id" text NOT NULL,
  "message_number" integer NOT NULL,
  "room_id" text NOT NULL,
  "agent_session_id" text NOT NULL,
  "agent_key" text NOT NULL,
  "actor_label" text NOT NULL,
  "activation_reason" text NOT NULL,
  "receipt_state" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "message_agent_receipts_message_fk" FOREIGN KEY ("message_room_id", "message_number") REFERENCES "messages"("room_id", "number") ON DELETE cascade ON UPDATE cascade,
  CONSTRAINT "message_agent_receipts_room_fk" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_agent_receipts_message_idx" ON "message_agent_receipts" ("message_room_id", "message_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_agent_receipts_session_idx" ON "message_agent_receipts" ("room_id", "agent_session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_agent_receipt_events" (
  "id" text PRIMARY KEY NOT NULL,
  "receipt_id" text NOT NULL REFERENCES "message_agent_receipts"("id") ON DELETE cascade ON UPDATE cascade,
  "message_room_id" text NOT NULL,
  "message_number" integer NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "actor_session_id" text,
  "timestamp" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_agent_receipt_events_receipt_idx" ON "message_agent_receipt_events" ("receipt_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_agent_observation_spans" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "agent_session_id" text NOT NULL,
  "agent_key" text NOT NULL,
  "first_message_sequence" integer NOT NULL,
  "last_message_sequence" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_agent_observation_spans_room_session_idx" ON "room_agent_observation_spans" ("room_id", "agent_session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_human_read_ranges" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE cascade,
  "scope_kind" text NOT NULL,
  "thread_root_number" integer,
  "first_message_sequence" integer NOT NULL,
  "last_message_sequence" integer NOT NULL,
  "client_batch_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_human_read_ranges_room_account_idx" ON "message_human_read_ranges" ("room_id", "account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_human_read_ranges_batch_uq" ON "message_human_read_ranges" ("room_id", "account_id", "client_batch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_agent_receipts_agent_key_idx" ON "message_agent_receipts" ("message_room_id", "agent_key", "message_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_agent_receipts_message_agent_uq" ON "message_agent_receipts" ("message_room_id", "message_number", "agent_key");
--> statement-breakpoint
ALTER TABLE "message_agent_receipts" ADD COLUMN IF NOT EXISTS "reply_message_number" integer;
