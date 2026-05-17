-- p4.1: Workspace Exposure Ledger (§10.7)
-- Creates the rental_workspace_exposures table for tracking
-- every file/content exposed to provider agents during rentals.

-- Enum for exposure types
CREATE TYPE "rental_exposure_type" AS ENUM ('file', 'search_result', 'directory_listing', 'command_output');--> statement-breakpoint

-- Enum for secret scan results
CREATE TYPE "rental_secret_scan_status" AS ENUM ('passed', 'redacted', 'blocked');--> statement-breakpoint

-- Workspace exposures table
CREATE TABLE IF NOT EXISTS "rental_workspace_exposures" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "path" text NOT NULL,
  "exposure_type" "rental_exposure_type" NOT NULL,
  "reason" text,
  "redaction_count" integer NOT NULL DEFAULT 0,
  "secret_scan_status" "rental_secret_scan_status" NOT NULL DEFAULT 'passed',
  "requested_by" text,
  "approved_by" text,
  "scope_id" text,
  "bytes_exposed" integer NOT NULL DEFAULT 0,
  "content_hash" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Foreign key: session_id → rental_sessions
ALTER TABLE "rental_workspace_exposures"
  ADD CONSTRAINT "rental_workspace_exposures_session_fk"
  FOREIGN KEY ("session_id") REFERENCES "rental_sessions"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint

-- Indexes
CREATE INDEX IF NOT EXISTS "rental_workspace_exposures_session_id_idx"
  ON "rental_workspace_exposures" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_workspace_exposures_session_path_idx"
  ON "rental_workspace_exposures" ("session_id", "path");
