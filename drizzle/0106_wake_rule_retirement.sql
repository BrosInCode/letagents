ALTER TABLE "agent_wake_rules" DROP CONSTRAINT IF EXISTS "agent_wake_rules_status_check";--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD CONSTRAINT "agent_wake_rules_status_check"
  CHECK ("status" IN ('active', 'fired', 'expired', 'cancelled', 'retired'));--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "ended_reason" text;
