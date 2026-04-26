DROP INDEX IF EXISTS "room_agent_sessions_active_worker_identity_idx";--> statement-breakpoint
CREATE INDEX "room_agent_sessions_room_agent_active_idx"
  ON "room_agent_sessions" USING btree ("room_id", "agent_key", "ended_at");
