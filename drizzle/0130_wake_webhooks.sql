-- Additive: wake webhooks. A room.message wake rule delivers by a signed HTTPS
-- POST to a URL its agent registered, so a hosted bot starts a turn when a
-- room message is for it. The rule keeps its delivery kind, the URL and secret
-- sealed with the connector key (never returned), the owning account, its delivery counters
-- and, after five final failures in a row, `paused`. A room.message rule may
-- have no expiry, so `expires_at` and `next_check_at` become nullable for that
-- event only. Deliveries are claimed and retried like desktop pushes; one per
-- rule may wait (`queued`), and matches meanwhile fold into it. Older servers
-- never create room.message rules and never read the new table.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_event_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_event_check"
  CHECK ("event" IN ('timer', 'task.status_changed', 'github.check_completed', 'github.review_submitted', 'github.pr_closed', 'room.message'));
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_status_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_status_check"
  CHECK ("status" IN ('active', 'fired', 'expired', 'cancelled', 'retired', 'paused'));
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ALTER COLUMN "expires_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ALTER COLUMN "next_check_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "owner_account_id" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_kind" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_target" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_consecutive_failures" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_dropped_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_delivered_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_last_status" integer;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_last_error" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_last_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_delivery_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_delivery_check"
  CHECK (("event" = 'room.message') = ("delivery_target" IS NOT NULL AND "delivery_kind" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_delivery_kind_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_delivery_kind_check"
  CHECK ("delivery_kind" IS NULL OR "delivery_kind" IN ('webhook'));
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_expiry_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_expiry_check"
  CHECK ("event" = 'room.message' OR ("expires_at" IS NOT NULL AND "next_check_at" IS NOT NULL));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wake_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL REFERENCES "agent_wake_rules"("id") ON DELETE CASCADE,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"message_number" integer NOT NULL,
	"sender" text NOT NULL,
	"text_preview" text NOT NULL,
	"match_count" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL CONSTRAINT "wake_webhook_deliveries_state_check"
		CHECK ("state" IN ('queued', 'retry', 'processing', 'delivered', 'dead')),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"last_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wake_webhook_deliveries_pending_uq" ON "wake_webhook_deliveries" USING btree ("rule_id") WHERE "state" = 'queued';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wake_webhook_deliveries_ready_idx" ON "wake_webhook_deliveries" USING btree ("next_attempt_at") WHERE "state" IN ('queued', 'retry');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wake_webhook_deliveries_rule_idx" ON "wake_webhook_deliveries" USING btree ("rule_id", "created_at");
