-- Additive: older servers never read these. A room has summaries on unless an admin turns them off.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "room_settings" ADD COLUMN IF NOT EXISTS "history_summary_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_history_summary_state" (
	"room_id" text PRIMARY KEY NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"next_number" integer NOT NULL,
	"leaf_count" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_history_summary_state_counts_check" CHECK ("next_number" >= 0 AND "leaf_count" >= 0 AND "failures" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_history_summary_state_available_idx" ON "room_history_summary_state" USING btree ("available_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_history_summary_nodes" (
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"level" integer NOT NULL,
	"idx" integer NOT NULL,
	"first_number" integer NOT NULL,
	"last_number" integer NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"built_at" timestamp with time zone,
	CONSTRAINT "room_history_summary_nodes_pk" PRIMARY KEY ("room_id", "level", "idx"),
	CONSTRAINT "room_history_summary_nodes_range_check" CHECK ("level" >= 0 AND "level" <= 40 AND "idx" >= 0 AND "first_number" <= "last_number"),
	CONSTRAINT "room_history_summary_nodes_text_check" CHECK ("text" IS NULL OR octet_length("text") BETWEEN 1 AND 512)
);
--> statement-breakpoint
-- Lines waiting for the summarizer: few, so the worker and every view read them by this index.
CREATE INDEX IF NOT EXISTS "room_history_summary_nodes_unbuilt_idx" ON "room_history_summary_nodes" USING btree ("room_id", "level", "idx") WHERE "text" IS NULL;
