-- Additive: older servers never write the column, and every existing session is a reasoning session.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "reasoning_sessions" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'reasoning' NOT NULL;
--> statement-breakpoint
-- Every existing row has the default, so NOT VALID skips only a pointless scan;
-- new and updated rows are still checked.
ALTER TABLE "reasoning_sessions" ADD CONSTRAINT "reasoning_sessions_kind_check" CHECK ("reasoning_sessions"."kind" IN ('reasoning', 'live')) NOT VALID;
--> statement-breakpoint
-- No row is a live session yet, so these partial indexes start empty.
CREATE INDEX IF NOT EXISTS "reasoning_sessions_live_agent_idx" ON "reasoning_sessions" USING btree ("room_id", "agent_key", "updated_at") WHERE "reasoning_sessions"."kind" = 'live';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_sessions_live_updated_idx" ON "reasoning_sessions" USING btree ("updated_at", "id") WHERE "reasoning_sessions"."kind" = 'live';
