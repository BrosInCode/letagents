-- Additive: older servers ignore the new delivery columns. Adding a nullable
-- column, or one with a constant default, changes only the catalog.
--
-- semantic_id becomes unique. Its duplicates are cleared, and the unique
-- index is built CONCURRENTLY, by the post-migration rollout
-- (src/api/db/github-webhook-integrity-rollout.ts), not here: Drizzle runs
-- pending migrations in one transaction, so a scan of github_room_events here
-- would hold the lock the ALTER below takes on github_webhook_deliveries, and
-- every incoming webhook would wait for it.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- The payload is kept only while a delivery is being processed, so a
-- delivery left 'received' by a process that died can be processed again.
ALTER TABLE github_webhook_deliveries
  ADD COLUMN payload jsonb,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0;
