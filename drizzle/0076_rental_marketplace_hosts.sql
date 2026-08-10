CREATE TABLE "rental_provider_hosts" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "host_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "max_concurrent_sessions" integer NOT NULL DEFAULT 1,
  "default_lrt_limit" integer NOT NULL DEFAULT 50000,
  "default_time_limit_minutes" integer NOT NULL DEFAULT 30,
  "manual_accept_required" boolean NOT NULL DEFAULT true,
  "runtimes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "daemon_generation" integer,
  "last_heartbeat_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "rental_provider_hosts_installation_uq" ON "rental_provider_hosts" ("provider_account_id", "host_id", "installation_id");--> statement-breakpoint
CREATE INDEX "rental_provider_hosts_online_idx" ON "rental_provider_hosts" ("enabled", "last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "rental_provider_hosts_provider_idx" ON "rental_provider_hosts" ("provider_account_id");--> statement-breakpoint

CREATE TABLE "rental_provider_events" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "session_id" text,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "rental_provider_events_provider_created_idx" ON "rental_provider_events" ("provider_account_id", "created_at", "id");--> statement-breakpoint

ALTER TABLE "rental_listings" ADD COLUMN "provider_host_id" text REFERENCES "rental_provider_hosts"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "rental_listings_provider_host_idx" ON "rental_listings" ("provider_host_id");--> statement-breakpoint

ALTER TABLE "rental_sessions" ADD COLUMN "target_room_id" text;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD CONSTRAINT "rental_sessions_target_room_fk" FOREIGN KEY ("target_room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "room_placement" text NOT NULL DEFAULT 'legacy_child';--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "room_history_access" text NOT NULL DEFAULT 'filtered';--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "capability_envelope" jsonb;--> statement-breakpoint
ALTER TABLE "rental_sessions" ALTER COLUMN "repo_provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rental_sessions" ALTER COLUMN "repo_owner" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rental_sessions" ALTER COLUMN "repo_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rental_sessions" ALTER COLUMN "base_branch" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "provider_host_id" text REFERENCES "rental_provider_hosts"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "selected_runtime" jsonb;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "launch_attempt" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "launch_state" text;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "daemon_entry_id" text;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "room_agent_session_id" text;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "launch_error_code" text;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "launch_error_message" text;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "initial_task_message_id" text;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "request_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "rental_sessions" SET "request_expires_at" = "created_at" + interval '15 minutes' WHERE "status" = 'requested' AND "request_expires_at" IS NULL;--> statement-breakpoint
CREATE INDEX "rental_sessions_provider_host_id_idx" ON "rental_sessions" ("provider_host_id");--> statement-breakpoint
CREATE INDEX "rental_sessions_target_room_id_idx" ON "rental_sessions" ("target_room_id");--> statement-breakpoint

DROP INDEX "supervisor_host_grants_active_host_idx";--> statement-breakpoint
ALTER TABLE "supervisor_host_grants" ADD COLUMN "scope_key" text NOT NULL DEFAULT 'owner';--> statement-breakpoint
ALTER TABLE "supervisor_host_grants" ADD COLUMN "rental_session_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "supervisor_host_grants_active_host_idx" ON "supervisor_host_grants" ("owner_account_id", "host_id", "installation_id", "scope_key") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "supervisor_host_grants_rental_session_idx" ON "supervisor_host_grants" ("rental_session_id");
