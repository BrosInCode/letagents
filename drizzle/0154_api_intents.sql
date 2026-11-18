-- Additive: LetAgents API intents (docs/plans/letagents-api.md, PR4).
-- `api_intents`: a proposed write (a kind and a payload) with the actor chain
-- that proposed it. Room policy decides it: it runs at once, waits for a room
-- admin (`pending_approval`), or is refused. An approved intent runs itself;
-- nobody re-sends it. The partial unique index keeps one pending intent per
-- proposer and change, so two people can propose the same change.
-- `workflow_effects`: a ticket write from an intent names no board card, so
-- `task_id` becomes nullable and `subject` names the ticket (`jira:HT-1234`).
-- Every existing row has a `task_id`, so the new CHECK holds for old rows.
-- Older servers never read `api_intents` and always write `task_id`.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"principal_login" text,
	"via_kind" text,
	"via_id" text,
	"via_version" integer,
	"state" text NOT NULL,
	"decided_by" text REFERENCES "accounts"("id") ON DELETE SET NULL,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"effect_id" text REFERENCES "workflow_effects"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_intents_kind_check" CHECK ("kind" IN ('task.create', 'task.update', 'ticket.transition', 'ticket.comment')),
	CONSTRAINT "api_intents_state_check" CHECK ("state" IN ('pending_approval', 'approved', 'running', 'done', 'failed', 'denied')),
	CONSTRAINT "api_intents_principal_kind_check" CHECK ("principal_kind" IN ('person', 'agent')),
	CONSTRAINT "api_intents_via_kind_check" CHECK ("via_kind" IS NULL OR "via_kind" IN ('page', 'job', 'integration')),
	CONSTRAINT "api_intents_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_intents_room_created_idx" ON "api_intents" USING btree ("room_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_intents_pending_uq" ON "api_intents" USING btree ("room_id", "kind", "payload_fingerprint", "principal_kind", "principal_id") WHERE "state" = 'pending_approval';
--> statement-breakpoint
ALTER TABLE "workflow_effects" ALTER COLUMN "task_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD COLUMN IF NOT EXISTS "subject" text;
--> statement-breakpoint
ALTER TABLE "workflow_effects" DROP CONSTRAINT IF EXISTS "workflow_effects_target_check";
--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD CONSTRAINT "workflow_effects_target_check" CHECK ("task_id" IS NOT NULL OR ("kind" IN ('tracker_transition', 'tracker_comment') AND "subject" IS NOT NULL));
