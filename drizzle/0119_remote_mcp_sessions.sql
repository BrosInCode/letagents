-- Additive: one row per remote (streamable HTTP) MCP session, so any API
-- replica can serve the session and it survives a restart. Older servers never
-- read this table.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "remote_mcp_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"token_hash" text NOT NULL,
	"agent_instance_id" text NOT NULL,
	"client_name" text,
	"room_id" text,
	"worker_session_id" text,
	"read_cursor" text,
	"state" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_mcp_sessions_account_idx" ON "remote_mcp_sessions" USING btree ("account_id", "last_seen_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_mcp_sessions_token_idx" ON "remote_mcp_sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_mcp_sessions_last_seen_idx" ON "remote_mcp_sessions" USING btree ("last_seen_at");
