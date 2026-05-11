DO $$ BEGIN
  CREATE TYPE "public"."rental_session_status" AS ENUM('requested', 'accepted', 'provisioning', 'active', 'blocked', 'patch_review', 'pr_opened', 'budget_exhausted', 'stale', 'completed', 'cancelled', 'expired', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."rental_mode" AS ENUM('scoped', 'trusted_open');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."rental_continuity_mode" AS ENUM('smart_handoff', 'full_transcript');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."rental_start_trigger" AS ENUM('quota_exhausted', 'user_initiated', 'scheduled', 'task_handoff');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."rental_trigger_confidence" AS ENUM('exact', 'inferred', 'manual');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rental_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "listing_id" text NOT NULL,
  "renter_account_id" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "room_id" text,
  "repo_provider" text DEFAULT 'github' NOT NULL,
  "repo_owner" text NOT NULL,
  "repo_name" text NOT NULL,
  "base_branch" text NOT NULL,
  "work_branch" text,
  "task_title" text NOT NULL,
  "task_prompt" text NOT NULL,
  "mode" "rental_mode" DEFAULT 'scoped' NOT NULL,
  "continuity_mode" "rental_continuity_mode" DEFAULT 'smart_handoff' NOT NULL,
  "continuity_pack" jsonb,
  "status" "rental_session_status" DEFAULT 'requested' NOT NULL,
  "approved_scope" jsonb,
  "policy" jsonb,
  "quota_lease" jsonb,
  "native_quota_unit" text,
  "native_quota_start_snapshot" jsonb,
  "native_quota_latest_snapshot" jsonb,
  "meter_confidence" text,
  "lrt_limit" integer,
  "lrt_reserved" integer DEFAULT 0 NOT NULL,
  "lrt_used" integer DEFAULT 0 NOT NULL,
  "budget_stop_threshold" numeric,
  "time_limit_minutes" integer,
  "start_trigger" "rental_start_trigger",
  "trigger_confidence" "rental_trigger_confidence",
  "renter_lane_exhausted_at" timestamp with time zone,
  "renter_lane_provider" text,
  "renter_lane_model" text,
  "renter_lane_refresh_eta" timestamp with time zone,
  "renter_quota_signal" jsonb,
  "renter_lane_recovered_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_sessions_listing_id_idx" ON "rental_sessions" USING btree ("listing_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_sessions_renter_account_id_idx" ON "rental_sessions" USING btree ("renter_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_sessions_provider_account_id_idx" ON "rental_sessions" USING btree ("provider_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_sessions_room_id_idx" ON "rental_sessions" USING btree ("room_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_sessions_renter_lane_exhausted_idx" ON "rental_sessions" USING btree ("renter_account_id", "renter_lane_exhausted_at");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "rental_sessions" ADD CONSTRAINT "rental_sessions_listing_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."rental_listings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "rental_sessions" ADD CONSTRAINT "rental_sessions_renter_fk" FOREIGN KEY ("renter_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "rental_sessions" ADD CONSTRAINT "rental_sessions_provider_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "rental_sessions" ADD CONSTRAINT "rental_sessions_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
