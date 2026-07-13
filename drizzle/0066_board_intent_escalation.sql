-- Escalation bookkeeping for board intents stuck pending with no reachable
-- Board Manager. escalated_at fences the one escalation action per intent
-- (auto-approval or human alert); auto_approved marks intents the liveness
-- sweep approved itself, feeding the per-proposer rate cap. Additive with
-- defaults, so existing rows and old readers are unaffected.
ALTER TABLE "board_intents" ADD COLUMN IF NOT EXISTS "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "board_intents" ADD COLUMN IF NOT EXISTS "auto_approved" boolean NOT NULL DEFAULT false;
