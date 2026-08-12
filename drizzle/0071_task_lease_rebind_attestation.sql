-- Terminal rebind attestation (plan §4.5). A fenced supervisor may only move an
-- in-flight work lease to a restarted worker AFTER it has persisted a terminal
-- attestation for the predecessor's execution: the exact tuple
-- {lease_id, epoch, from_agent_session_id} it observed as dead, bound to the
-- grant that authored it (grant_id + supervisor_generation), plus the
-- work_attempt_id / execution_generation_id the daemon reported and the cause.
-- rebindTaskLease consumes exactly one un-consumed attestation for that tuple in
-- the same transaction (setting consumed_at + consumed_by_epoch), so a single
-- observed termination can authorize at most one rebind. The partial unique
-- index enforces at most one un-consumed attestation per predecessor tuple.
-- Evidence is IMMUTABLE: a write conflicting with the pending row is refused
-- (insert-or-identical), never merged or refreshed; consumed rows are retained
-- as an audit trail.
--
-- The CHECKs make the evidence invariants hold at the database, not only in the
-- accessor: only observed-process-exit causes are attestable (explicit
-- revocation without an observed exit is NOT a rebind-authorizing cause — see
-- REBIND_ATTESTATION_CAUSES), epochs are nonnegative, grant generations are
-- positive, and a row is consumed exactly when it records the consuming epoch.
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
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "task_lease_rebind_attestations_cause_check"
    CHECK ("cause" IN ('exited', 'killed', 'stopped', 'crashed', 'protocol_error')),
  CONSTRAINT "task_lease_rebind_attestations_epoch_check"
    CHECK ("epoch" >= 0),
  CONSTRAINT "task_lease_rebind_attestations_generation_check"
    CHECK ("supervisor_generation" > 0),
  CONSTRAINT "task_lease_rebind_attestations_consumed_coupling_check"
    CHECK (("consumed_at" IS NULL) = ("consumed_by_epoch" IS NULL)),
  CONSTRAINT "task_lease_rebind_attestations_consumed_epoch_check"
    CHECK ("consumed_by_epoch" IS NULL OR "consumed_by_epoch" > "epoch")
);--> statement-breakpoint
CREATE UNIQUE INDEX "task_lease_rebind_attestations_unconsumed_idx" ON "task_lease_rebind_attestations" USING btree ("lease_id", "epoch", "from_agent_session_id") WHERE "task_lease_rebind_attestations"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_lease_rebind_attestations_lease_idx" ON "task_lease_rebind_attestations" USING btree ("lease_id");
