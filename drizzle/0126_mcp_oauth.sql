-- Additive: OAuth 2.1 for the remote MCP endpoint (/mcp). LetAgents is the
-- authorization server. Codes, consent tokens, grant secrets, client secrets
-- and access/refresh tokens are stored only as SHA-256 hex. Older servers
-- never read these tables.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_name" text,
	"redirect_uris" jsonb NOT NULL,
	"token_endpoint_auth_method" text NOT NULL,
	"client_secret_hash" text,
	"application_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_clients_unused_idx" ON "mcp_oauth_clients" USING btree ("created_at") WHERE "last_used_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_grants" (
	"grant_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"client_id" text NOT NULL REFERENCES "mcp_oauth_clients"("client_id") ON DELETE CASCADE,
	"secret_hash" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_grants_secret_idx" ON "mcp_oauth_grants" USING btree ("secret_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_account_idx" ON "mcp_oauth_grants" USING btree ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_client_idx" ON "mcp_oauth_grants" USING btree ("client_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL REFERENCES "mcp_oauth_grants"("grant_id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_tokens_kind_check" CHECK ("kind" IN ('access', 'refresh'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_grant_idx" ON "mcp_oauth_tokens" USING btree ("grant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_expires_idx" ON "mcp_oauth_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_authorizations" (
	"authorization_id" text PRIMARY KEY NOT NULL,
	"consent_hash" text NOT NULL,
	"code_hash" text,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"client_id" text NOT NULL REFERENCES "mcp_oauth_clients"("client_id") ON DELETE CASCADE,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"grant_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_authorizations_consent_idx" ON "mcp_oauth_authorizations" USING btree ("consent_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_authorizations_code_idx" ON "mcp_oauth_authorizations" USING btree ("code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_authorizations_expires_idx" ON "mcp_oauth_authorizations" USING btree ("expires_at");
