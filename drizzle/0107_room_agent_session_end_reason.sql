-- Why a session ended, when that changes what happens to its work. Only a
-- room admin's disconnect is recorded: its leases stay behind for the admin
-- to release instead of passing to the agent's next session.
ALTER TABLE "room_agent_sessions" ADD COLUMN IF NOT EXISTS "end_reason" text
  CHECK ("end_reason" IN ('room_admin'));
