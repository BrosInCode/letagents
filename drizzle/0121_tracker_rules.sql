-- Ticket connectors (PR5): team-written rules that move a ticket when a repo
-- event matches, their version history, and an audit row per rule run.
-- Additive for older servers: they never read the new tables.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracker_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL REFERENCES "tracker_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"room_id" text REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_rules_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_rules_connection_idx" ON "tracker_rules" USING btree ("connection_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracker_rule_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL REFERENCES "tracker_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"room_id" text,
	"trigger" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tracker_rule_versions_rule_version_uq" ON "tracker_rule_versions" USING btree ("rule_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracker_rule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text REFERENCES "tracker_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE,
	"rule_version" integer NOT NULL,
	"rule_name" text NOT NULL,
	"connection_id" text NOT NULL,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"task_id" text NOT NULL,
	"external_ref" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_action" text NOT NULL,
	"event_url" text,
	"planned_actions" jsonb NOT NULL,
	"effect_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_rule_runs_outcome_check" CHECK ("outcome" IN ('pending', 'succeeded', 'failed', 'quarantined', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tracker_rule_runs_rule_delivery_uq" ON "tracker_rule_runs" USING btree ("rule_id", "delivery_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_rule_runs_room_created_idx" ON "tracker_rule_runs" USING btree ("room_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_rule_runs_debounce_idx" ON "tracker_rule_runs" USING btree ("rule_id", "external_ref", "created_at");
