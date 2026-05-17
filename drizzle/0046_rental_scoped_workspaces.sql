-- p4.0: Scoped Workspace Materialization (§10.6)
-- Creates the rental_workspace_manifests table for tracking
-- ephemeral workspaces created for rental sessions.

-- Enum for workspace retention lifecycle
CREATE TYPE "rental_workspace_retention_status" AS ENUM ('active', 'archived', 'expired', 'deleted');--> statement-breakpoint

-- Workspace manifests table
CREATE TABLE IF NOT EXISTS "rental_workspace_manifests" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "base_commit_sha" text NOT NULL,
  "work_branch" text NOT NULL,
  "scope_globs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "workspace_path" text,
  "files_materialized" integer NOT NULL DEFAULT 0,
  "bytes_materialized" integer NOT NULL DEFAULT 0,
  "retention_status" "rental_workspace_retention_status" NOT NULL DEFAULT 'active',
  "materialized_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Foreign key: session_id → rental_sessions
ALTER TABLE "rental_workspace_manifests"
  ADD CONSTRAINT "rental_workspace_manifests_session_fk"
  FOREIGN KEY ("session_id") REFERENCES "rental_sessions"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint

-- Indexes
CREATE INDEX IF NOT EXISTS "rental_workspace_manifests_session_id_idx"
  ON "rental_workspace_manifests" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_workspace_manifests_retention_idx"
  ON "rental_workspace_manifests" ("retention_status", "expires_at");
