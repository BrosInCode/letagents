-- Re-runnable: the stop an address pressed (wake_email_suppressions) goes with
-- the rule that set it, which is deleted only when its room is deleted. Before
-- this, deleting the room left the address stopped for good: the stop link
-- answers 404 once the rule row is gone, and a new rule for the address is
-- refused while the stop stands. Rows whose rule is already gone are exactly
-- those addresses, so they are released before the constraint is added.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DELETE FROM "wake_email_suppressions"
 WHERE "rule_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "agent_wake_rules" WHERE "agent_wake_rules"."id" = "wake_email_suppressions"."rule_id");
--> statement-breakpoint
ALTER TABLE "wake_email_suppressions" DROP CONSTRAINT IF EXISTS "wake_email_suppressions_rule_id_agent_wake_rules_id_fk";
--> statement-breakpoint
ALTER TABLE "wake_email_suppressions" ADD CONSTRAINT "wake_email_suppressions_rule_id_agent_wake_rules_id_fk"
  FOREIGN KEY ("rule_id") REFERENCES "agent_wake_rules"("id") ON DELETE CASCADE;
