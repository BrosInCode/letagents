-- Terminal rebind attestation (plan §4.5). A fenced supervisor may only move an
-- in-flight work lease to a restarted worker AFTER it has persisted a terminal
-- attestation for the predecessor's execution: the exact tuple
-- {lease_id, epoch, from_agent_session_id} it observed as dead, bound to the
-- grant that authored it (grant_id + supervisor_generation), plus the opaque
-- work_attempt_id / execution_generation_id the daemon reported and the cause.
-- rebindTaskLease consumes exactly one un-consumed attestation for that tuple in
-- the same transaction (setting consumed_at + consumed_by_epoch), so a single
-- observed termination can authorize at most one rebind. The partial unique
-- index enforces at most one un-consumed attestation per predecessor tuple, so a
-- retry of the write route refreshes the pending row rather than stacking
-- duplicates; consumed rows are retained as an audit trail.
CREATE TABLE "task_lease_rebind_attestations" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "lease_id" text NOT NULL REFERENCES "task_leases"("id") ON DELETE cascade ON UPDATE cascade,
  "epoch" integer NOT NULL,
  "from_agent_session_id" text NOT NULL,
  "grant_id" text NOT NULL REFERENCES "supervisor_host_grants"("grant_id") ON DELETE cascade ON UPDATE cascade,
  "supervisor_generation" integer NOT NULL,
  "work_attempt_id" text NOT NULL,
  "execution_generation_id" text NOT NULL,
  "cause" text NOT NULL,
  "attested_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by_epoch" integer,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "task_lease_rebind_attestations_unconsumed_idx" ON "task_lease_rebind_attestations" USING btree ("lease_id", "epoch", "from_agent_session_id") WHERE "task_lease_rebind_attestations"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_lease_rebind_attestations_lease_idx" ON "task_lease_rebind_attestations" USING btree ("lease_id");
