-- Additive: one row per remote MCP credential (owner token or OAuth grant)
-- holding the merged runtime state of all the sessions it opened, so a client
-- that starts a new MCP session for every tool call (ChatGPT) keeps its worker
-- handles, rooms and read cursors. The state is sealed with a key derived from
-- the credential; the table keeps only the credential's SHA-256. Older servers
-- never read this table. A session row also learns whether it is the
-- credential's implicit session (serves requests sent without a session id);
-- one such row per credential.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "remote_mcp_credentials" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"state" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_mcp_credentials_account_idx" ON "remote_mcp_credentials" USING btree ("account_id");
--> statement-breakpoint
ALTER TABLE "remote_mcp_sessions" ADD COLUMN IF NOT EXISTS "implicit" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "remote_mcp_sessions_implicit_token_idx" ON "remote_mcp_sessions" USING btree ("token_hash") WHERE "implicit";
