import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../client.js";
import {
  room_agent_session_bearers,
  room_agent_sessions,
  supervisor_host_grants,
  task_lease_rebind_attestations,
  task_leases,
} from "../schema.js";
import { toTaskLease } from "../mappers.js";
import { assertSupervisorGrantFenceTx, type SupervisorGrantFence } from "../auth.js";
import type { RebindAttestationRow, TaskLease, TaskLeaseKind, TaskLeaseRow, TaskLeaseStatus } from "../types.js";
import { coordinationId } from "../utils.js";

// Why rebind exists (plan §4.5): a supervised worker that dies and restarts
// registers a NEW agent session, but its in-flight lease is bound to the OLD
// session id. A prompt cannot cross that authorization boundary, so ownership
// is moved server-side under the supervisor's fenced authority. The old
// session's delivery + bearer are revoked in the same transaction, so the
// predecessor's credentials stop resolving and its lease-guarded writes fail
// at authentication; `epoch` is the additional monotonic fence that makes
// concurrent rebinds resolve to exactly one winner.

// The strict terminal vocabulary an attestation may carry, mirroring the
// daemon adapter's ProviderTerminalCause — every value asserts an OBSERVED
// process exit. Explicit revocation without an observed exit is deliberately
// NOT attestable: an ended auth session can leave a live OS process writing
// the reused workspace (the §4.5 two-writer hazard), so revocation may only
// authorize a rebind once a durable process-terminal/workspace-fence proof
// (P1b/P1d) can stand in for the observed exit. Free-form causes are rejected —
// the attestation is normative evidence, not a log line.
export const REBIND_ATTESTATION_CAUSES = [
  "exited",         // clean process exit
  "killed",         // SIGKILL / force stop
  "stopped",        // graceful SIGTERM stop
  "crashed",        // unexpected death
  "protocol_error", // harness/RPC violation
] as const;
export type RebindAttestationCause = (typeof REBIND_ATTESTATION_CAUSES)[number];
export function isRebindAttestationCause(value: unknown): value is RebindAttestationCause {
  return typeof value === "string" && (REBIND_ATTESTATION_CAUSES as readonly string[]).includes(value);
}

// P1b mints work_attempt_id / execution_generation_id with crypto.randomUUID()
// (durability-store.ts). Enforcing the shape here means an attestation can only
// name a plausibly-real P1b execution identity — arbitrary strings cannot be
// persisted as evidence by an otherwise-scoped grant.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuidShapedExecutionId(value: unknown): value is string {
  return typeof value === "string" && UUID_SHAPE.test(value);
}

export type RebindTaskLeaseFailure =
  | "lost_race"          // lease id/status/epoch/from-session CAS did not match
  | "grant_fence_stale"  // supervisor grant generation/token_version/expiry invalid
  | "grant_scope"        // grant does not authorize this room + agent identity
  | "session_mismatch"   // sessions missing, cross-room, wrong key/kind/owner, or not under this grant
  | "predecessor_live"   // the from-session is not ended (not terminal)
  | "kind_not_rebindable" // only work leases are rebindable; review leases must be released
  | "attestation_missing" // no un-consumed terminal attestation for this predecessor tuple
  | "attestation_stale"   // attestation exists but was authored by a different/older grant generation
  | "attestation_mismatch"; // attestation exists but is not the exact execution proof presented

export interface RebindTaskLeaseInput {
  lease_id: string;
  expected_epoch: number;
  from_agent_session_id: string;
  to_agent_session_id: string;
  supervisor_grant_fence: SupervisorGrantFence;
  // The EXACT terminal proof being consumed (§4.5). The caller must name the
  // attestation row and the execution identity it attested; the rebind matches
  // all three against the pending attestation for the predecessor tuple.
  // Without this, a rebind would consume whichever pending proof happened to
  // exist, decoupling the consumed evidence from the execution the supervisor
  // actually observed terminate.
  attestation_id: string;
  work_attempt_id: string;
  execution_generation_id: string;
}

export type RebindTaskLeaseResult =
  | { ok: true; lease: TaskLease }
  | { ok: false; reason: RebindTaskLeaseFailure };

// Internal rollback sentinel. Every failure inside the rebind transaction is
// raised as a throw — never a plain return — so Drizzle ROLLS BACK the
// transaction. A plain `return {ok:false}` from the callback COMMITS whatever
// side effects already ran (bearer revocation, attestation consumption), which
// would let a failed final lease CAS burn the one-time proof without moving
// the lease. Translated back to a result value in rebindTaskLease's catch.
class RebindAbortError extends Error {
  readonly rebindFailureReason: RebindTaskLeaseFailure;
  constructor(reason: RebindTaskLeaseFailure) {
    super(`Lease rebind aborted: ${reason}`);
    this.name = "RebindAbortError";
    this.rebindFailureReason = reason;
  }
}

export async function rebindTaskLease(input: RebindTaskLeaseInput): Promise<RebindTaskLeaseResult> {
  try {
    const lease = await db.transaction(async (tx) => {
      const abort = (reason: RebindTaskLeaseFailure): never => { throw new RebindAbortError(reason); };

      // Serialize concurrent rebinds of the same lease so the epoch CAS below has
      // exactly one winner even under simultaneous supervisor attempts.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task_lease:${input.lease_id}`}, 0))`);

      // Authority: the supervisor grant must be current (generation + token
      // version + not revoked/expired). Same agent_key alone is never enough.
      if (!(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
        abort("grant_fence_stale");
      }

      const [lease] = await tx
        .select()
        .from(task_leases)
        .where(and(
          eq(task_leases.id, input.lease_id),
          eq(task_leases.status, "active" as TaskLeaseStatus),
          eq(task_leases.epoch, input.expected_epoch),
          eq(task_leases.agent_session_id, input.from_agent_session_id),
        ))
        .limit(1);
      if (!lease) abort("lost_race");

      // Only WORK leases are rebindable. A review lease's authority cannot be
      // proven by the work-attempt/execution-generation terminal attestation the
      // rebind consumes (§4.5), so the generic route must not silently move one —
      // a dead reviewer's review lease is released, not rebound. Guard here so no
      // caller can slip a non-work kind past the attestation model.
      if (lease.kind !== ("work" as TaskLeaseKind)) {
        abort("kind_not_rebindable");
      }

      // Grant scope: the grant must explicitly cover this lease's room and agent
      // identity — a valid grant for a different room/agent may not move it.
      const [grant] = await tx
        .select()
        .from(supervisor_host_grants)
        .where(eq(supervisor_host_grants.grant_id, input.supervisor_grant_fence.grant_id))
        .limit(1);
      if (!grant
        || !grant.allowed_room_ids.includes(lease.room_id)
        || !grant.allowed_agent_keys.includes(lease.agent_key)) {
        abort("grant_scope");
      }

      const [fromSession] = await tx
        .select()
        .from(room_agent_sessions)
        .where(eq(room_agent_sessions.session_id, input.from_agent_session_id))
        .limit(1);
      const [toSession] = await tx
        .select()
        .from(room_agent_sessions)
        .where(eq(room_agent_sessions.session_id, input.to_agent_session_id))
        .limit(1);
      if (!fromSession || !toSession
        || fromSession.agent_key !== toSession.agent_key
        || toSession.agent_key !== lease.agent_key
        || fromSession.room_id !== lease.room_id
        || toSession.room_id !== lease.room_id) {
        abort("session_mismatch");
      }
      // Bind BOTH sides to the fenced supervisor authority — same agent_key is not
      // enough. The successor must have been minted under THIS grant (so a session
      // another host registered under the same canonical key cannot receive the
      // lease), both sides must be workers owned by the grant's owner, and the
      // successor must be live. This is the "wrong host/authority" AC.
      if (toSession.ended_at
        || toSession.session_kind !== "worker"
        || fromSession.session_kind !== "worker"
        || toSession.owner_account_id !== grant.owner_account_id
        || fromSession.owner_account_id !== grant.owner_account_id
        || toSession.supervisor_grant_id !== grant.grant_id
        // BOTH sides bound to this grant: the predecessor must also have been
        // minted under it, so a grant for host A cannot seize a same-key lease
        // whose predecessor belongs to host B.
        || fromSession.supervisor_grant_id !== grant.grant_id) {
        abort("session_mismatch");
      }

      // The predecessor must be genuinely terminal: its session is ended (which
      // also revokes its bearer). Delivery-unreachability is NOT termination — a
      // live worker between long-poll reconnects has no delivery row — so we do
      // not wrest a lease on reachability alone. (Attempt-level terminal state
      // from P1b can later widen this; session-ended is the conservative floor.)
      if (!fromSession.ended_at) {
        abort("predecessor_live");
      }
      // The successor must have been minted AFTER the predecessor terminated.
      // In the supervised flow the restart registers a fresh session once the
      // old execution is observed dead; an OLDER live same-grant session is not
      // that restart, and letting it receive the lease would hand authority to
      // a parallel writer that predates the attested termination.
      if (new Date(toSession!.created_at).getTime() <= new Date(fromSession!.ended_at!).getTime()) {
        abort("session_mismatch");
      }

      // Terminal attestation (§4.5): session-ended is the conservative floor, but
      // the authorizing proof is a server-persisted attestation that the SAME grant
      // observed THIS predecessor execution terminate. Require exactly one
      // un-consumed attestation for the {lease, epoch, from-session} tuple, authored
      // by this grant at its current generation, AND require the caller to name it
      // exactly: attestation id + work-attempt + execution-generation must all
      // match, so the consumed proof is the precise execution the supervisor
      // observed terminate — never "whichever pending proof exists".
      const [attestation] = await tx
        .select()
        .from(task_lease_rebind_attestations)
        .where(and(
          eq(task_lease_rebind_attestations.lease_id, input.lease_id),
          eq(task_lease_rebind_attestations.epoch, input.expected_epoch),
          eq(task_lease_rebind_attestations.from_agent_session_id, input.from_agent_session_id),
          isNull(task_lease_rebind_attestations.consumed_at),
        ))
        .limit(1);
      if (!attestation) abort("attestation_missing");
      if (attestation!.grant_id !== grant!.grant_id
        || attestation!.supervisor_generation !== input.supervisor_grant_fence.generation) {
        abort("attestation_stale");
      }
      if (attestation!.id !== input.attestation_id
        || attestation!.work_attempt_id !== input.work_attempt_id
        || attestation!.execution_generation_id !== input.execution_generation_id) {
        abort("attestation_mismatch");
      }

      const now = new Date().toISOString();

      // The predecessor's session is already ended (enforced above). Defensively
      // revoke any bearer that outlived the session so its credentials cannot
      // resolve past the rebind.
      await tx.update(room_agent_session_bearers)
        .set({ revoked_at: now })
        .where(and(
          eq(room_agent_session_bearers.session_id, input.from_agent_session_id),
          isNull(room_agent_session_bearers.revoked_at),
        ));

      // Consume the EXACT attestation presented, exactly once, in this same
      // transaction, before the lease moves. The `consumed_at IS NULL` guard makes
      // the flip a CAS; the full-tuple WHERE re-asserts the match so even an
      // internal caller cannot consume a different row than it validated.
      const [consumed] = await tx
        .update(task_lease_rebind_attestations)
        .set({ consumed_at: now, consumed_by_epoch: lease!.epoch + 1, updated_at: now })
        .where(and(
          eq(task_lease_rebind_attestations.id, input.attestation_id),
          eq(task_lease_rebind_attestations.lease_id, input.lease_id),
          eq(task_lease_rebind_attestations.epoch, input.expected_epoch),
          eq(task_lease_rebind_attestations.from_agent_session_id, input.from_agent_session_id),
          isNull(task_lease_rebind_attestations.consumed_at),
        ))
        .returning({ id: task_lease_rebind_attestations.id });
      if (!consumed) abort("attestation_missing");

      // Fenced rebind: repoint the lease to the successor and bump the epoch. The
      // WHERE clause re-asserts the CAS predicate; if a writer that did not honor
      // the advisory lock changed the row since the validating SELECT, this
      // matches 0 rows and the abort ROLLS BACK the consumption and revocation
      // above — a lost race never burns the one-time proof.
      const [updated] = await tx
        .update(task_leases)
        .set({
          agent_session_id: input.to_agent_session_id,
          agent_key: toSession!.agent_key,
          agent_instance_id: toSession!.agent_instance_id ?? null,
          actor_label: toSession!.actor_label,
          epoch: lease!.epoch + 1,
          updated_at: now,
          last_heartbeat_at: now,
        })
        .where(and(
          eq(task_leases.id, input.lease_id),
          eq(task_leases.status, "active" as TaskLeaseStatus),
          eq(task_leases.epoch, input.expected_epoch),
          eq(task_leases.agent_session_id, input.from_agent_session_id),
        ))
        .returning();
      if (!updated) abort("lost_race");

      return toTaskLease(updated as TaskLeaseRow);
    });
    return { ok: true, lease };
  } catch (error) {
    if (error instanceof RebindAbortError) {
      return { ok: false, reason: error.rebindFailureReason };
    }
    throw error;
  }
}

// Thrown by a lease-guarded write when its fence is stale — the lease moved to
// another session, advanced past the observed epoch, or is no longer active.
// Routes map this to 409 `coordination_lease_fence_stale`.
export class LeaseFenceStaleError extends Error {
  readonly code = "coordination_lease_fence_stale";
  constructor(message = "The work lease advanced or moved before this write committed.") {
    super(message);
    this.name = "LeaseFenceStaleError";
  }
}

// The full identity a lease-guarded write must still hold at commit time. epoch
// and agent_session_id are REQUIRED, never optional (plan §4.5): a write whose
// authority derives from holding a lease must prove it holds the CURRENT lease.
export interface LeaseFence {
  lease_id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  expected_epoch: number;
  agent_session_id: string;
}

// Canonical lease fence. Must be called INSIDE the same transaction as the
// guarded side effect. A plain SELECT assertion at READ COMMITTED is TOCTOU: a
// rebind (or another lease action) can commit between the validating read and
// the guarded write. Taking the SAME `task_lease:<id>` xact advisory lock that
// rebindTaskLease uses linearizes the two — whichever acquires the lock first
// runs to commit and the loser observes its state. Returns the still-valid
// lease row, or null when the fence is stale (moved session / advanced epoch /
// wrong room-task-kind / no longer active). Callers throw LeaseFenceStaleError
// on null AFTER releasing to the route (or let a wrapper do so).
export async function acquireLeaseFenceTx(
  tx: any,
  fence: LeaseFence,
): Promise<TaskLeaseRow | null> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task_lease:${fence.lease_id}`}, 0))`,
  );
  const [row] = await tx
    .select()
    .from(task_leases)
    .where(and(
      eq(task_leases.id, fence.lease_id),
      eq(task_leases.room_id, fence.room_id),
      eq(task_leases.task_id, fence.task_id),
      eq(task_leases.kind, fence.kind),
      eq(task_leases.status, "active" as TaskLeaseStatus),
      eq(task_leases.epoch, fence.expected_epoch),
      eq(task_leases.agent_session_id, fence.agent_session_id),
    ))
    .limit(1);
  return (row as TaskLeaseRow) ?? null;
}

// A lease-guarded write may re-verify that the caller still holds the exact
// lease epoch it last observed. After a rebind the epoch has advanced, so a
// partitioned-but-live predecessor that somehow still authenticates is rejected
// here even before actor/session identity is considered. Takes the same xact
// advisory lock as rebind so the check is not TOCTOU under READ COMMITTED.
export async function assertLeaseEpochCurrentTx(
  tx: any,
  input: { lease_id: string; expected_epoch: number; agent_session_id: string },
): Promise<boolean> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task_lease:${input.lease_id}`}, 0))`,
  );
  const [row] = await tx
    .select({ id: task_leases.id })
    .from(task_leases)
    .where(and(
      eq(task_leases.id, input.lease_id),
      eq(task_leases.status, "active" as TaskLeaseStatus),
      eq(task_leases.epoch, input.expected_epoch),
      eq(task_leases.agent_session_id, input.agent_session_id),
    ))
    .limit(1);
  return Boolean(row);
}

export type RecordRebindAttestationFailure =
  | "invalid_cause"              // cause outside the strict terminal/revocation enum
  | "invalid_execution_identity" // work_attempt/execution_generation not UUID-shaped P1b ids
  | "grant_fence_stale"          // supervisor grant generation/token_version/expiry invalid
  | "lease_not_found"            // no such lease
  | "grant_scope"                // grant does not cover the lease's room + agent identity
  | "lease_mismatch"             // lease not active/work, epoch not current, or from is not the holder
  | "session_mismatch"           // predecessor session missing/cross-room/wrong key/kind/owner/grant
  | "predecessor_live"           // predecessor session is not terminal
  | "evidence_conflict";         // a pending attestation exists with DIFFERENT evidence

export interface RecordRebindAttestationInput {
  lease_id: string;
  // The epoch + predecessor session the supervisor observed terminate — the
  // exact tuple rebindTaskLease matches and consumes. The epoch must be the
  // lease's CURRENT epoch and the session its CURRENT holder.
  epoch: number;
  from_agent_session_id: string;
  // The authoring supervisor's fence. The recorded grant_id/supervisor_generation
  // are taken from this validated fence — never caller-supplied — so a stale or
  // forged generation cannot be persisted as evidence.
  supervisor_grant_fence: SupervisorGrantFence;
  // P1b execution identity (UUID-shaped, minted by the daemon's durability
  // store). Part of the exact tuple the rebind must present and match.
  work_attempt_id: string;
  execution_generation_id: string;
  cause: string;
}

export type RecordRebindAttestationResult =
  | { ok: true; attestation: RebindAttestationRow; created: boolean }
  | { ok: false; reason: RecordRebindAttestationFailure };

// Persist a terminal rebind attestation (plan §4.5). Written by the fenced
// supervisor (via the grant-authenticated route) BEFORE it attempts a rebind:
// it records the exact predecessor execution tuple the supervisor observed as
// terminal.
//
// Evidence is IMMUTABLE: the insert is insert-or-return-identical. An identical
// retry returns the existing pending row untouched (created:false); a retry
// carrying ANY differing evidence (grant, generation, execution ids, cause)
// fails with `evidence_conflict` — recorded evidence is never overwritten.
//
// Authority is validated INSIDE the same locked transaction as the insert
// (default-deny even for internal callers): the grant fence must be current,
// the grant must scope the lease's room + agent, the lease must be an active
// work lease at exactly this epoch with `from` as its current holder, and the
// predecessor session must be a terminal worker minted under this grant.
// It takes the same `task_lease:<id>` advisory lock as rebindTaskLease, so an
// attest cannot interleave with a rebind's validate/consume window.
export async function recordRebindAttestation(
  input: RecordRebindAttestationInput,
): Promise<RecordRebindAttestationResult> {
  if (!isRebindAttestationCause(input.cause)) {
    return { ok: false, reason: "invalid_cause" };
  }
  if (!isUuidShapedExecutionId(input.work_attempt_id)
    || !isUuidShapedExecutionId(input.execution_generation_id)) {
    return { ok: false, reason: "invalid_execution_identity" };
  }
  if (!Number.isInteger(input.epoch) || input.epoch < 0) {
    return { ok: false, reason: "lease_mismatch" };
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task_lease:${input.lease_id}`}, 0))`);

    if (!(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
      return { ok: false as const, reason: "grant_fence_stale" as const };
    }
    const [grant] = await tx
      .select()
      .from(supervisor_host_grants)
      .where(eq(supervisor_host_grants.grant_id, input.supervisor_grant_fence.grant_id))
      .limit(1);
    if (!grant) return { ok: false as const, reason: "grant_fence_stale" as const };

    const [lease] = await tx
      .select()
      .from(task_leases)
      .where(eq(task_leases.id, input.lease_id))
      .limit(1);
    if (!lease) return { ok: false as const, reason: "lease_not_found" as const };
    if (!grant.allowed_room_ids.includes(lease.room_id)
      || !grant.allowed_agent_keys.includes(lease.agent_key)) {
      return { ok: false as const, reason: "grant_scope" as const };
    }
    // Attest only the lease's CURRENT reality: an active work lease at exactly
    // this epoch whose holder is the named predecessor. Anything else would
    // persist evidence about a lease state that does not exist.
    if (lease.status !== ("active" as TaskLeaseStatus)
      || lease.kind !== ("work" as TaskLeaseKind)
      || lease.epoch !== input.epoch
      || lease.agent_session_id !== input.from_agent_session_id) {
      return { ok: false as const, reason: "lease_mismatch" as const };
    }

    const [fromSession] = await tx
      .select()
      .from(room_agent_sessions)
      .where(eq(room_agent_sessions.session_id, input.from_agent_session_id))
      .limit(1);
    if (!fromSession
      || fromSession.room_id !== lease.room_id
      || fromSession.agent_key !== lease.agent_key
      || fromSession.session_kind !== "worker"
      || fromSession.owner_account_id !== grant.owner_account_id
      || fromSession.supervisor_grant_id !== grant.grant_id) {
      return { ok: false as const, reason: "session_mismatch" as const };
    }
    // Terminal-or-revoked: an attestation asserts the supervisor observed this
    // execution end. A live predecessor session cannot be attested terminal.
    if (!fromSession.ended_at) {
      return { ok: false as const, reason: "predecessor_live" as const };
    }

    const now = new Date().toISOString();
    const [inserted] = await tx
      .insert(task_lease_rebind_attestations)
      .values({
        id: coordinationId("tlra"),
        room_id: lease.room_id,
        lease_id: input.lease_id,
        epoch: input.epoch,
        from_agent_session_id: input.from_agent_session_id,
        grant_id: grant.grant_id,
        supervisor_generation: input.supervisor_grant_fence.generation,
        work_attempt_id: input.work_attempt_id,
        execution_generation_id: input.execution_generation_id,
        cause: input.cause,
        attested_at: now,
        consumed_at: null,
        consumed_by_epoch: null,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing({
        target: [
          task_lease_rebind_attestations.lease_id,
          task_lease_rebind_attestations.epoch,
          task_lease_rebind_attestations.from_agent_session_id,
        ],
        // Conflict-target predicate matching the partial unique index — for
        // onConflictDoNothing drizzle emits this as ON CONFLICT (...) WHERE ...
        where: sql`${task_lease_rebind_attestations.consumed_at} IS NULL`,
      })
      .returning();
    if (inserted) {
      return { ok: true as const, attestation: inserted as RebindAttestationRow, created: true };
    }

    // A pending attestation already exists for this tuple. Identical evidence →
    // idempotent retry, return the original row untouched. Differing evidence →
    // refuse; the recorded proof is immutable.
    const [existing] = await tx
      .select()
      .from(task_lease_rebind_attestations)
      .where(and(
        eq(task_lease_rebind_attestations.lease_id, input.lease_id),
        eq(task_lease_rebind_attestations.epoch, input.epoch),
        eq(task_lease_rebind_attestations.from_agent_session_id, input.from_agent_session_id),
        isNull(task_lease_rebind_attestations.consumed_at),
      ))
      .limit(1);
    if (!existing) return { ok: false as const, reason: "evidence_conflict" as const };
    const identical = existing.grant_id === grant.grant_id
      && existing.supervisor_generation === input.supervisor_grant_fence.generation
      && existing.work_attempt_id === input.work_attempt_id
      && existing.execution_generation_id === input.execution_generation_id
      && existing.cause === input.cause;
    if (!identical) return { ok: false as const, reason: "evidence_conflict" as const };
    return { ok: true as const, attestation: existing as RebindAttestationRow, created: false };
  });
}
