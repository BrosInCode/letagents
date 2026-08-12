-- Brokered coordinated effects (room-agents rewrite §4.6 / P3a). The unique
-- room/idempotency and provider/correlation indexes are the durable authority:
-- concurrent workers can reserve one logical effect, and provider artifacts
-- carry correlation_key so an ambiguous write can be reconciled by lookup.
CREATE TABLE "workflow_effects" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "task_id" text NOT NULL,
  "lease_id" text NOT NULL REFERENCES "task_leases"("id") ON DELETE restrict ON UPDATE cascade,
  "kind" text NOT NULL,
  "provider" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "correlation_key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "request_payload" jsonb NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "processing_token" text,
  "processing_started_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone,
  "external_id" text,
  "external_url" text,
  "response_payload" jsonb,
  "last_error" text,
  "quarantined_at" timestamp with time zone,
  "quarantine_reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "workflow_effects_state_check" CHECK ("state" IN ('pending', 'succeeded', 'failed', 'ambiguous')),
  CONSTRAINT "workflow_effects_kind_check" CHECK ("kind" IN ('github_review_verdict')),
  CONSTRAINT "workflow_effects_provider_check" CHECK ("provider" IN ('github')),
  CONSTRAINT "workflow_effects_attempt_count_check" CHECK ("attempt_count" >= 0 AND "attempt_count" <= "max_attempts"),
  CONSTRAINT "workflow_effects_max_attempts_check" CHECK ("max_attempts" > 0),
  CONSTRAINT "workflow_effects_processing_coupling_check" CHECK (("processing_token" IS NULL) = ("processing_started_at" IS NULL)),
  CONSTRAINT "workflow_effects_success_evidence_check" CHECK ("state" <> 'succeeded' OR ("external_id" IS NOT NULL AND "completed_at" IS NOT NULL)),
  CONSTRAINT "workflow_effects_quarantine_coupling_check" CHECK (("quarantined_at" IS NULL) = ("quarantine_reason" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_effects_room_idempotency_uq" ON "workflow_effects" USING btree ("room_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_effects_provider_correlation_uq" ON "workflow_effects" USING btree ("provider", "correlation_key");--> statement-breakpoint
CREATE INDEX "workflow_effects_reconciliation_idx" ON "workflow_effects" USING btree ("state", "updated_at");--> statement-breakpoint
CREATE INDEX "workflow_effects_schedule_idx" ON "workflow_effects" USING btree ("state", "next_attempt_at", "processing_started_at");--> statement-breakpoint
CREATE INDEX "workflow_effects_retention_idx" ON "workflow_effects" USING btree ("updated_at") WHERE "state" = 'succeeded' OR ("state" = 'failed' AND "attempt_count" >= "max_attempts") OR "quarantined_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_effects_room_task_idx" ON "workflow_effects" USING btree ("room_id", "task_id");
