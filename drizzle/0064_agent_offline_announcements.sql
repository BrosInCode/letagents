-- Additive, nullable dedupe markers for room-visible agent liveness announcements.
-- offline_announced_at: when the offline announcement for the current disconnect
-- epoch was posted (compared against last_disconnected_at, so a reconnect + later
-- death re-announces while a still-dead session never repeats).
-- recovery_announced_at: when the matching recovery announcement was posted.
ALTER TABLE "room_agent_delivery_sessions" ADD COLUMN IF NOT EXISTS "offline_announced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ADD COLUMN IF NOT EXISTS "recovery_announced_at" timestamp with time zone;
