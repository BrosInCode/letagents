CREATE TABLE "supervisor_host_grants" (
  "grant_id" text PRIMARY KEY NOT NULL,
  "owner_account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "host_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "token_version" integer NOT NULL DEFAULT 1,
  "allowed_room_ids" text[] NOT NULL,
  "allowed_agent_keys" text[] NOT NULL,
  "current_generation" integer NOT NULL DEFAULT 1,
  "issued_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "supervisor_host_grants_active_host_idx" ON "supervisor_host_grants" USING btree ("owner_account_id", "host_id", "installation_id") WHERE "supervisor_host_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "supervisor_host_grants_owner_idx" ON "supervisor_host_grants" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "supervisor_host_grants_expiry_idx" ON "supervisor_host_grants" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "room_agent_session_bearers" ADD COLUMN "supervisor_grant_id" text REFERENCES "supervisor_host_grants"("grant_id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "room_agent_session_bearers_grant_id_idx" ON "room_agent_session_bearers" USING btree ("supervisor_grant_id");
--> statement-breakpoint
ALTER TABLE "room_agent_sessions" ADD COLUMN "supervisor_grant_id" text REFERENCES "supervisor_host_grants"("grant_id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "room_agent_sessions_grant_id_idx" ON "room_agent_sessions" USING btree ("supervisor_grant_id");
