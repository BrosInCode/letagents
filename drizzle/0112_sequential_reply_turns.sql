-- Additive: older servers ignore the new receipt columns and keep parallel delivery.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE message_agent_receipts
  ADD COLUMN turn_position integer,
  ADD COLUMN turn_count integer,
  ADD COLUMN hold_release_after timestamptz,
  ADD COLUMN hold_released_at timestamptz,
  ADD COLUMN hold_release_reason text,
  ADD COLUMN turn_done_at timestamptz;
--> statement-breakpoint
-- The held-only partial indexes are built CONCURRENTLY by the post-migration
-- rollout (src/api/db/reply-turn-hold-rollout.ts). Drizzle wraps this file in
-- one transaction, where an ordinary CREATE INDEX would block every receipt
-- writer, and so every message send, for the duration of the build.
-- NULL means parallel (today's behaviour); only 'sequential' turns reply order on.
ALTER TABLE room_settings
  ADD COLUMN agent_reply_order text,
  ADD CONSTRAINT room_settings_agent_reply_order_check
    CHECK (agent_reply_order IS NULL OR agent_reply_order IN ('sequential', 'parallel'));
