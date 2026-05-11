DO $$ BEGIN
  CREATE TYPE "public"."rental_listing_status" AS ENUM('active', 'paused', 'disabled', 'setup_required');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."rental_verification_status" AS ENUM('verified', 'partially_verified', 'experimental', 'unreachable');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."rental_meter_confidence" AS ENUM('official_exact', 'local_exact', 'derived', 'calibrated', 'estimated', 'weak_estimate', 'unknown');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."rental_native_quota_unit" AS ENUM('tokens', 'credits', 'usd', 'requests', 'percent_window', 'time', 'unknown');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rental_listings" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_account_id" text NOT NULL,
  "display_name" text NOT NULL,
  "status" "rental_listing_status" DEFAULT 'setup_required' NOT NULL,
  "verification_status" "rental_verification_status" DEFAULT 'experimental' NOT NULL,
  "readiness_badges" jsonb DEFAULT '[]'::jsonb,
  "ide_kind" text NOT NULL,
  "model_label" text,
  "quota_lane_id" text,
  "quota_lane_label" text,
  "meter_confidence" "rental_meter_confidence" DEFAULT 'unknown' NOT NULL,
  "native_quota_unit" "rental_native_quota_unit" DEFAULT 'unknown' NOT NULL,
  "last_native_quota_snapshot" jsonb,
  "last_lrt_estimate" integer,
  "last_quota_reset_at" timestamp with time zone,
  "verified_agent_fingerprint_id" text,
  "supported_modes" jsonb DEFAULT '["scoped"]'::jsonb NOT NULL,
  "max_concurrent_sessions" integer DEFAULT 1 NOT NULL,
  "default_lrt_limit" integer,
  "default_time_limit_minutes" integer,
  "manual_accept_required" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_listings_provider_account_id_idx" ON "rental_listings" USING btree ("provider_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_listings_status_idx" ON "rental_listings" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_listings_ide_kind_idx" ON "rental_listings" USING btree ("ide_kind");
