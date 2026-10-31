-- Ticket connectors (PR2): one account's link to Jira or Linear, cached tracker
-- items, single-use OAuth states, and tracker effects in the workflow journal.
-- Additive for older servers: they never read the new tables, and the journal
-- keeps every existing row valid (GitHub verdicts still require a lease).
-- Older servers would hand a tracker_* journal row to their GitHub reconciler,
-- so no tracker effect may be created before every API instance runs this
-- release. Nothing creates one in this release (the rules engine comes later).
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracker_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"site_key" text NOT NULL,
	"site_url" text,
	"auth_kind" text NOT NULL,
	"credentials_ciphertext" text NOT NULL,
	"credentials_iv" text NOT NULL,
	"credentials_version" integer DEFAULT 1 NOT NULL,
	"tracker_user_id" text,
	"tracker_user_label" text,
	"status_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unmapped_statuses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"jev_linking_enabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_connections_provider_check" CHECK ("provider" IN ('jira', 'linear')),
	CONSTRAINT "tracker_connections_auth_kind_check" CHECK ("auth_kind" IN ('oauth', 'api_token')),
	CONSTRAINT "tracker_connections_status_check" CHECK ("status" IN ('active', 'needs_reauth', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tracker_connections_account_site_uq" ON "tracker_connections" USING btree ("account_id", "provider", "site_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_items" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL REFERENCES "tracker_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"provider" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"ticket_state" text NOT NULL,
	"raw_status" text NOT NULL,
	"assignee_id" text,
	"assignee_label" text,
	"url" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tracker_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_items_provider_check" CHECK ("provider" IN ('jira', 'linear')),
	CONSTRAINT "external_items_ticket_state_check" CHECK ("ticket_state" IN ('todo', 'in_progress', 'in_review', 'done'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_items_connection_key_uq" ON "external_items" USING btree ("connection_id", "key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_items_connection_assignee_idx" ON "external_items" USING btree ("connection_id", "assignee_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracker_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"provider" text NOT NULL,
	"loopback_port" integer NOT NULL,
	"code_verifier" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_oauth_states_provider_check" CHECK ("provider" IN ('jira', 'linear')),
	CONSTRAINT "tracker_oauth_states_loopback_port_check" CHECK ("loopback_port" BETWEEN 1024 AND 65535)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_oauth_states_expires_idx" ON "tracker_oauth_states" USING btree ("expires_at");
--> statement-breakpoint
-- Tracker effects are reserved by rules on repo events, not under a review
-- lease. A GitHub review verdict still needs its lease. lookup_count counts
-- reconciliation lookups that found nothing (a tracker transition fails after 3).
ALTER TABLE "workflow_effects" ADD COLUMN IF NOT EXISTS "lookup_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow_effects" ALTER COLUMN "lease_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow_effects" DROP CONSTRAINT IF EXISTS "workflow_effects_kind_check";
--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD CONSTRAINT "workflow_effects_kind_check" CHECK ("kind" IN ('github_review_verdict', 'tracker_transition', 'tracker_comment'));
--> statement-breakpoint
ALTER TABLE "workflow_effects" DROP CONSTRAINT IF EXISTS "workflow_effects_provider_check";
--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD CONSTRAINT "workflow_effects_provider_check" CHECK ("provider" IN ('github', 'jira', 'linear'));
--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD CONSTRAINT "workflow_effects_kind_provider_check" CHECK (
	("kind" = 'github_review_verdict' AND "provider" = 'github' AND "lease_id" IS NOT NULL)
	OR ("kind" IN ('tracker_transition', 'tracker_comment') AND "provider" IN ('jira', 'linear'))
);
