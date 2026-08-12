-- Fence for the room stall watchdog: when a board that previously had work
-- drains to zero open tasks with no reachable Board Manager, the liveness
-- sweep posts one nudge per drain epoch and records it here. Additive and
-- nullable, so existing rows and old readers are unaffected.
ALTER TABLE "room_board_settings" ADD COLUMN IF NOT EXISTS "stall_nudged_at" timestamp with time zone;
