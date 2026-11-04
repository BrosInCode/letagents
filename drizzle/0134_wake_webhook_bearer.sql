-- Additive and re-runnable: a webhook wake rule may carry the receiver's own
-- sender key, sent as `Authorization: Bearer <key>` on each delivery. It is
-- sealed with the connector key like the URL and secret (bound to the rule
-- and account), never returned and never part of the rule's identity. Older
-- servers ignore the column and send no Authorization header. A rule that has
-- ended for good (retired or expired) drops its sealed target and key, so the
-- delivery check now asks for a target only while a rule can still deliver.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_bearer" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_delivery_bearer_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_delivery_bearer_check"
  CHECK ("delivery_bearer" IS NULL OR "delivery_kind" = 'webhook');
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_delivery_check";
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_delivery_check"
  CHECK ((("event" = 'room.message') = ("delivery_kind" IS NOT NULL))
    AND ("delivery_kind" IS NULL OR "delivery_target" IS NOT NULL OR "status" IN ('retired', 'expired')));
