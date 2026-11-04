-- Additive: hardening of webhook and email wake rules before release.
-- A delivery rule records the credential that registered it (an owner token
-- or OAuth grant by its SHA-256, or a worker session) and stops when it is
-- revoked; keyed fingerprints of its target and target host bound its hourly
-- budgets (per rule, per account in a room, per account and host). One held rule per identity whatever its status (active, paused or
-- waiting for confirmation). Deliveries carry their account and host for the
-- budgets; one waiting past a spent budget is marked. Email confirmations are
-- logged per address fingerprint (counted per day, cancelled rules included),
-- and an address that pressed Stop is remembered until it asks again.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "credential_kind" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "credential_ref" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_credential_kind_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_credential_kind_check"
  CHECK ("credential_kind" IS NULL OR "credential_kind" IN ('token', 'agent_session'));
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_target_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_host_fingerprint" text;
--> statement-breakpoint
DO $$
BEGIN
  -- Re-runnable: rename only while the old name is still there.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'agent_wake_rules'
                AND column_name = 'delivery_dropped_count') THEN
    ALTER TABLE "agent_wake_rules" RENAME COLUMN "delivery_dropped_count" TO "delivery_over_cap_count";
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_wake_rules_active_identity_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wake_rules_held_identity_uq" ON "agent_wake_rules" USING btree ("room_id", "agent_key", "identity_key") WHERE "status" IN ('active', 'paused', 'pending_confirmation');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wake_rules_held_next_check_idx" ON "agent_wake_rules" USING btree ("next_check_at") WHERE "status" IN ('active', 'paused', 'pending_confirmation');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wake_rules_credential_idx" ON "agent_wake_rules" USING btree ("credential_kind", "credential_ref") WHERE "status" IN ('active', 'paused', 'pending_confirmation');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wake_rules_owner_delivery_idx" ON "agent_wake_rules" USING btree ("owner_account_id") WHERE "delivery_kind" IS NOT NULL AND "status" IN ('active', 'paused', 'pending_confirmation');
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ADD COLUMN IF NOT EXISTS "owner_account_id" text;
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ADD COLUMN IF NOT EXISTS "host_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ADD COLUMN IF NOT EXISTS "held_by_cap" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "wake_webhook_deliveries_rule_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wake_webhook_deliveries_rule_idx" ON "wake_webhook_deliveries" USING btree ("rule_id", "scheduled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wake_webhook_deliveries_room_account_idx" ON "wake_webhook_deliveries" USING btree ("room_id", "owner_account_id", "scheduled_at") WHERE "purpose" = 'message';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wake_webhook_deliveries_host_idx" ON "wake_webhook_deliveries" USING btree ("owner_account_id", "host_fingerprint", "scheduled_at") WHERE "purpose" = 'message';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wake_webhook_deliveries_in_flight_idx" ON "wake_webhook_deliveries" USING btree ("owner_account_id") WHERE "state" = 'processing';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wake_email_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"address_fingerprint" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"rule_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wake_email_confirmations_address_idx" ON "wake_email_confirmations" USING btree ("address_fingerprint", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wake_email_confirmations_account_idx" ON "wake_email_confirmations" USING btree ("owner_account_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wake_email_suppressions" (
	"address_fingerprint" text PRIMARY KEY NOT NULL,
	"rule_id" text,
	"created_at" timestamp with time zone NOT NULL
);
