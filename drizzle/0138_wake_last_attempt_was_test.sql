-- Additive and re-runnable: a webhook wake rule remembers whether its last
-- delivery attempt was a person's test, so the app can say "last test 200"
-- instead of "last 200" for an answer that did not come from a room message.
-- The test route sets it; every real delivery attempt clears it. Older
-- servers ignore the column and leave the mark as it is, so during a rollout
-- an old server that delivers a real message after a test leaves it true
-- until the next attempt made by the new code.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "agent_wake_rules" ADD COLUMN IF NOT EXISTS "delivery_last_attempt_was_test" boolean DEFAULT false NOT NULL;
