-- Additive: jobs, structured work a person (or later a page or a trigger)
-- hands to one agent in a room through the LetAgents API. A job that reached
-- an agent is linked to the thread root it posted, whose client_message_id is
-- `internal:job:<id>` (a namespace ordinary senders cannot use). A job made
-- while no agent was online has no message. Older servers never read this table.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "principal_kind" text NOT NULL,
  "principal_id" text NOT NULL,
  "via_kind" text,
  "via_id" text,
  "via_version" integer,
  "target_agent_key" text,
  "instruction" text NOT NULL,
  "input" jsonb,
  "result_schema" jsonb,
  "state" text NOT NULL,
  "progress" text,
  "result" jsonb,
  "error" text,
  "root_message_number" integer,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "api_jobs_state_check" CHECK ("state" IN ('queued', 'no_agent', 'running', 'needs_input', 'done', 'failed', 'cancelled')),
  CONSTRAINT "api_jobs_principal_kind_check" CHECK ("principal_kind" IN ('person', 'agent')),
  CONSTRAINT "api_jobs_via_kind_check" CHECK ("via_kind" IS NULL OR "via_kind" IN ('page', 'job', 'integration'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_jobs_room_created_idx" ON "api_jobs" USING btree ("room_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_jobs_room_state_idx" ON "api_jobs" USING btree ("room_id", "state", "created_at" DESC);
