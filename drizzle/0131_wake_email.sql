-- Additive: email as a second delivery kind for room.message wake rules. The
-- address is sealed in delivery_target like a webhook's URL and secret. A new
-- email rule waits in `pending_confirmation` until its address opens the
-- confirmation link; the rule keeps only SHA-256 hashes of its confirmation
-- and stop links (the links themselves are HMACs under the connector key).
-- Deliveries gain a kind and a purpose (a room message, or the confirmation);
-- a confirmation carries no message, and a rule may have one of each waiting.
-- Older servers never create email rules.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_status_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_status_check"
  CHECK ("status" IN ('active', 'fired', 'expired', 'cancelled', 'retired', 'paused', 'pending_confirmation'));
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_delivery_kind_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_delivery_kind_check"
  CHECK ("delivery_kind" IS NULL OR "delivery_kind" IN ('webhook', 'email'));
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "confirm_token_hash" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "confirm_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "disable_token_hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wake_rules_confirm_token_uq" ON "agent_wake_rules" USING btree ("confirm_token_hash") WHERE "confirm_token_hash" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wake_rules_disable_token_uq" ON "agent_wake_rules" USING btree ("disable_token_hash") WHERE "disable_token_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wake_rules_pending_email_idx" ON "agent_wake_rules" USING btree ("owner_account_id") WHERE "status" = 'pending_confirmation';
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'webhook' NOT NULL;
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'message' NOT NULL;
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ALTER COLUMN "message_number" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" DROP CONSTRAINT IF EXISTS "wake_webhook_deliveries_kind_check";
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ADD CONSTRAINT "wake_webhook_deliveries_kind_check"
  CHECK ("kind" IN ('webhook', 'email'));
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" DROP CONSTRAINT IF EXISTS "wake_webhook_deliveries_purpose_check";
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ADD CONSTRAINT "wake_webhook_deliveries_purpose_check"
  CHECK (("purpose" = 'message' AND "message_number" IS NOT NULL) OR ("purpose" = 'confirm' AND "kind" = 'email'));
--> statement-breakpoint
DROP INDEX IF EXISTS "wake_webhook_deliveries_pending_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wake_webhook_deliveries_pending_uq" ON "wake_webhook_deliveries" USING btree ("rule_id", "purpose") WHERE "state" = 'queued';
