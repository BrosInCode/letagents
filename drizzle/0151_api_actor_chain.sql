-- Additive: the LetAgents API actor chain (docs/plans/letagents-api.md, PR1).
-- `api_page_tokens`: short-lived `page_grant` bearer tokens. The desktop main
-- process mints one with the person's session for one page version in one
-- room; the page never sees it. Only the SHA-256 hex of the token is stored.
-- `session_id` is the app session that minted it: signing out of that
-- session (or its expiry) ends the token, and only that session's tokens.
-- `page_id` and `page_version` have no foreign key yet: the pages tables
-- arrive with the pages registry (PR7), which may add one.
-- `room_api_policies`: a room admin's choice per capability; no row means the
-- default from shared/api/capabilities.mjs.
-- `api_actions`: append-only record of API writes, intents and jobs with the
-- actor chain. Older servers never read these tables.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_page_tokens" (
	"token_id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"session_id" text NOT NULL REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"page_id" text NOT NULL,
	"page_version" integer NOT NULL,
	"capabilities" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_page_tokens_page_version_check" CHECK ("page_version" > 0),
	CONSTRAINT "api_page_tokens_capabilities_check" CHECK (jsonb_typeof("capabilities") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_page_tokens_token_hash_idx" ON "api_page_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_page_tokens_account_idx" ON "api_page_tokens" USING btree ("account_id", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_page_tokens_room_page_idx" ON "api_page_tokens" USING btree ("room_id", "page_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_page_tokens_session_idx" ON "api_page_tokens" USING btree ("session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_api_policies" (
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"capability" text NOT NULL,
	"mode" text NOT NULL,
	"updated_by" text REFERENCES "accounts"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_api_policies_pkey" PRIMARY KEY ("room_id", "capability"),
	CONSTRAINT "room_api_policies_mode_check" CHECK ("mode" IN ('allow', 'confirm', 'approve', 'deny'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_actions" (
	"action_id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"via_kind" text,
	"via_id" text,
	"via_version" integer,
	"method" text NOT NULL,
	"capability" text NOT NULL,
	"target" text,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_actions_principal_kind_check" CHECK ("principal_kind" IN ('person', 'agent')),
	CONSTRAINT "api_actions_via_kind_check" CHECK ("via_kind" IS NULL OR "via_kind" IN ('page', 'job', 'integration'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_actions_room_created_idx" ON "api_actions" USING btree ("room_id", "created_at");
