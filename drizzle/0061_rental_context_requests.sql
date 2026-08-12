-- Context access requests: pending renter approvals for out-of-scope
-- context asks from rented provider agents.

CREATE TYPE "rental_context_request_type" AS ENUM ('read_file', 'search', 'directory_listing', 'command_output');--> statement-breakpoint

CREATE TYPE "rental_context_request_status" AS ENUM ('pending', 'approved', 'denied', 'expired');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rental_context_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "path" text NOT NULL,
  "request_type" "rental_context_request_type" NOT NULL DEFAULT 'read_file',
  "status" "rental_context_request_status" NOT NULL DEFAULT 'pending',
  "reason" text,
  "requested_by" text,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

ALTER TABLE "rental_context_requests"
  ADD CONSTRAINT "rental_context_requests_session_fk"
  FOREIGN KEY ("session_id") REFERENCES "rental_sessions"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rental_context_requests_session_id_idx"
  ON "rental_context_requests" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_context_requests_status_idx"
  ON "rental_context_requests" ("session_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rental_context_requests_pending_path_uq"
  ON "rental_context_requests" ("session_id", "path")
  WHERE "status" = 'pending';
