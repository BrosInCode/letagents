ALTER TABLE "room_agent_sessions"
  ADD COLUMN "process_seen_at" timestamp with time zone,
  ADD COLUMN "process_connection_id" text,
  ADD COLUMN "process_disconnected_at" timestamp with time zone,
  ADD COLUMN "process_host_id" text,
  ADD COLUMN "agent_heard_at" timestamp with time zone;
