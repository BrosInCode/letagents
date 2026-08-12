SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions"
  ADD COLUMN IF NOT EXISTS "credential_fingerprint" text,
  ADD COLUMN IF NOT EXISTS "credential_epoch" integer;
