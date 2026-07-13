-- Per-room policy for what the liveness sweep does when the active Board
-- Manager's worker session goes unreachable: 'off' ignores it, 'announce'
-- posts a room warning with a suggested successor, 'auto' (default) promotes
-- the best reachable worker. Additive with a default, so existing rows and
-- old readers are unaffected.
ALTER TABLE "room_board_settings" ADD COLUMN IF NOT EXISTS "manager_failover" text NOT NULL DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE "room_board_settings" DROP CONSTRAINT IF EXISTS "room_board_settings_manager_failover_check";--> statement-breakpoint
ALTER TABLE "room_board_settings" ADD CONSTRAINT "room_board_settings_manager_failover_check" CHECK ("manager_failover" IN ('off', 'announce', 'auto'));
