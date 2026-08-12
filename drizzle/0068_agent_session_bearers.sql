-- Short-lived worker credentials are intentionally independent from the
-- long-lived body session token. Existing sessions receive no bearer row and
-- therefore cannot become bearer-authenticated merely by this migration.
CREATE TABLE "room_agent_session_bearers" (
  "bearer_id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL REFERENCES "room_agent_sessions"("session_id") ON DELETE cascade ON UPDATE cascade,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "token_hash" text NOT NULL UNIQUE,
  "generation" integer NOT NULL,
  "capabilities" text[] NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "rotated_from_bearer_id" text,
  "created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "room_agent_session_bearers_session_id_idx" ON "room_agent_session_bearers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "room_agent_session_bearers_room_id_idx" ON "room_agent_session_bearers" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_agent_session_bearers_active_session_idx" ON "room_agent_session_bearers" USING btree ("session_id", "revoked_at", "expires_at");
CREATE UNIQUE INDEX "room_agent_session_bearers_session_generation_idx" ON "room_agent_session_bearers" USING btree ("session_id", "generation");
