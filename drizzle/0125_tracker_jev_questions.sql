-- Ticket connectors (PR6): one row per question LetAgents asks Jev for a
-- tracker connection (link a pull request, read a closed pull request, who a
-- card waits on, draft a rule). The unique key makes one question per pull
-- request head, per closed pull request, and per card and last message; the
-- rows are also the metrics (count, latency, outcome) and the record of a
-- person's accept or reject. Board intents gain the type for "Move KEY?".
-- Additive for older servers: they never read the new table, and they never
-- write the new intent type.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracker_jev_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL REFERENCES "tracker_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"room_id" text REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"revision" text NOT NULL,
	"task_id" text,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"latency_ms" integer,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_jev_questions_kind_check" CHECK ("kind" IN ('link', 'exception', 'needs_me', 'rule_draft')),
	CONSTRAINT "tracker_jev_questions_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('accepted', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tracker_jev_questions_subject_uq" ON "tracker_jev_questions" USING btree ("kind", coalesce("room_id", ''), "subject", "revision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_jev_questions_room_kind_created_idx" ON "tracker_jev_questions" USING btree ("room_id", "kind", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_jev_questions_connection_created_idx" ON "tracker_jev_questions" USING btree ("connection_id", "created_at");
--> statement-breakpoint
ALTER TABLE "board_intents" DROP CONSTRAINT IF EXISTS "board_intents_action_type_check";
--> statement-breakpoint
ALTER TABLE "board_intents" ADD CONSTRAINT "board_intents_action_type_check" CHECK ("action_type" IN ('task_create', 'task_claim', 'task_close', 'task_override', 'task_update', 'tracker_jev_link')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "board_intents" VALIDATE CONSTRAINT "board_intents_action_type_check";
