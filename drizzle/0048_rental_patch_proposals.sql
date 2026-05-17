CREATE TYPE "public"."rental_patch_proposal_source" AS ENUM('signed_change_journal', 'explicit_patch', 'raw_diff');
--> statement-breakpoint
CREATE TYPE "public"."rental_patch_gate_status" AS ENUM('pending', 'passed', 'passed_with_warnings', 'needs_renter_approval', 'rejected', 'needs_revision', 'timed_out');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rental_patch_proposals" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "source" "rental_patch_proposal_source" NOT NULL,
  "diff_ref" text,
  "summary" text,
  "gate_status" "rental_patch_gate_status" DEFAULT 'pending' NOT NULL,
  "risk_score" integer,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "check_results" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "journal_entry" jsonb,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "response_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental_patch_proposals" ADD CONSTRAINT "rental_patch_proposals_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."rental_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_patch_proposals_session_id_idx" ON "rental_patch_proposals" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_patch_proposals_gate_status_idx" ON "rental_patch_proposals" USING btree ("gate_status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rental_patch_proposals_session_idempotency_uq" ON "rental_patch_proposals" USING btree ("session_id","idempotency_key");
