-- Additive: a person can send one test delivery to a webhook wake rule of
-- their own agent from the app. The test goes through the real delivery
-- pipeline and is recorded like a delivery, with purpose 'test': it carries
-- no room message, counts against the rule's hourly budget, and never
-- counts toward pausing the rule. The worker never claims a test row.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" DROP CONSTRAINT IF EXISTS "wake_webhook_deliveries_purpose_check";
--> statement-breakpoint
ALTER TABLE "wake_webhook_deliveries" ADD CONSTRAINT "wake_webhook_deliveries_purpose_check"
  CHECK (("purpose" = 'message' AND "message_number" IS NOT NULL) OR ("purpose" = 'confirm' AND "kind" = 'email') OR ("purpose" = 'test' AND "kind" = 'webhook'));
