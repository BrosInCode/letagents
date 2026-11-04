-- Additive: MCP Events subscriptions as a third delivery kind of room.message
-- wake rules. ChatGPT (a Work chat or a dot) subscribes over the remote MCP
-- endpoint (`events/subscribe`) with a callback URL and a Standard Webhooks
-- secret; LetAgents stores the subscription as a wake rule bound to the OAuth
-- grant or owner token behind the session, sealed like a webhook rule, and
-- delivers each matching message as one signed event. The rule keeps the
-- subscription id ChatGPT derives its renewals from, the event name, the
-- canonical subscription arguments and the last delivered cursor (a room
-- message number). `expires_at` is the `refreshBefore` the client was given.
-- One held rule per credential and subscription id. Deliveries of this kind
-- are never coalesced: each is one row, inserted as `retry` (waiting) because
-- `queued` is the one coalescing slot of a webhook or email rule. Older
-- servers never create this kind and never claim its rows (the worker claims
-- by kind).
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_delivery_kind_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_delivery_kind_check"
  CHECK ("delivery_kind" IS NULL OR "delivery_kind" IN ('webhook', 'email', 'mcp_event'));
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "mcp_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "mcp_event_name" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "mcp_arguments" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "mcp_cursor" text;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_mcp_subscription_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_mcp_subscription_check"
  CHECK (("delivery_kind" = 'mcp_event') = ("mcp_subscription_id" IS NOT NULL AND "mcp_event_name" IS NOT NULL AND "mcp_arguments" IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wake_rules_mcp_subscription_uq" ON "agent_wake_rules" USING btree ("credential_ref", "mcp_subscription_id")
  WHERE "mcp_subscription_id" IS NOT NULL AND "status" IN ('active', 'paused', 'pending_confirmation');
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" DROP CONSTRAINT IF EXISTS "wake_webhook_deliveries_kind_check";
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ADD CONSTRAINT "wake_webhook_deliveries_kind_check"
  CHECK ("kind" IN ('webhook', 'email', 'mcp_event'));
