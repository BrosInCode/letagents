ALTER TABLE "board_intents" DROP CONSTRAINT IF EXISTS "board_intents_status_check";--> statement-breakpoint
ALTER TABLE "board_intents" ADD CONSTRAINT "board_intents_status_check"
  CHECK ("status" IN ('pending', 'approved', 'denied', 'expired', 'used', 'superseded'));--> statement-breakpoint
ALTER TABLE "board_intents" ADD COLUMN IF NOT EXISTS "approved_task_status" text;--> statement-breakpoint
ALTER TABLE "board_intents" ADD COLUMN IF NOT EXISTS "approved_task_assignee_agent_key" text;--> statement-breakpoint
ALTER TABLE "board_intents" ADD COLUMN IF NOT EXISTS "approved_manager_assignment_id" text;--> statement-breakpoint
DROP INDEX IF EXISTS "board_intents_pending_action_payload_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "board_intents_pending_action_payload_idx" ON "board_intents" (
  "room_id", "action_type", "payload_hash",
  COALESCE("proposer_agent_session_id", ''), COALESCE("proposer_actor_key", ''),
  COALESCE("proposer_worker_auth_kind", '')
) WHERE "status" = 'pending';
