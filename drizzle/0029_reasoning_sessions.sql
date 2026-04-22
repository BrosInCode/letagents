CREATE TABLE "reasoning_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "task_id" text,
  "anchor_message_id" text,
  "actor_label" text NOT NULL,
  "agent_key" text,
  "status" "agent_presence_status",
  "summary" text NOT NULL,
  "latest_payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "reasoning_sessions_room_updated_idx" ON "reasoning_sessions" USING btree ("room_id","updated_at");
--> statement-breakpoint
CREATE INDEX "reasoning_sessions_room_open_idx" ON "reasoning_sessions" USING btree ("room_id","closed_at","updated_at");
--> statement-breakpoint
CREATE INDEX "reasoning_sessions_room_actor_idx" ON "reasoning_sessions" USING btree ("room_id","actor_label");
--> statement-breakpoint
CREATE INDEX "reasoning_sessions_room_task_idx" ON "reasoning_sessions" USING btree ("room_id","task_id");
--> statement-breakpoint
CREATE TABLE "reasoning_session_updates" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "session_id" text NOT NULL REFERENCES "reasoning_sessions"("id") ON DELETE cascade ON UPDATE cascade,
  "actor_label" text NOT NULL,
  "status" "agent_presence_status",
  "summary" text NOT NULL,
  "milestone" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reasoning_session_updates_session_created_idx" ON "reasoning_session_updates" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE INDEX "reasoning_session_updates_room_created_idx" ON "reasoning_session_updates" USING btree ("room_id","created_at");
