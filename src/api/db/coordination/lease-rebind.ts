import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../client.js";
import {
  room_agent_session_bearers,
  room_agent_sessions,
  supervisor_host_grants,
  task_leases,
} from "../schema.js";
import { toTaskLease } from "../mappers.js";
import { assertSupervisorGrantFenceTx, type SupervisorGrantFence } from "../auth.js";
import type { TaskLease, TaskLeaseRow, TaskLeaseStatus } from "../types.js";

// Why rebind exists (plan §4.5): a supervised worker that dies and restarts
// registers a NEW agent session, but its in-flight lease is bound to the OLD
// session id. A prompt cannot cross that authorization boundary, so ownership
// is moved server-side under the supervisor's fenced authority. The old
// session's delivery + bearer are revoked in the same transaction, so the
// predecessor's credentials stop resolving and its lease-guarded writes fail
// at authentication; `epoch` is the additional monotonic fence that makes
// concurrent rebinds resolve to exactly one winner.

export type RebindTaskLeaseFailure =
  | "lost_race"          // lease id/status/epoch/from-session CAS did not match
  | "grant_fence_stale"  // supervisor grant generation/token_version/expiry invalid
  | "grant_scope"        // grant does not authorize this room + agent identity
  | "session_mismatch"   // sessions missing, cross-room, wrong key/kind/owner, or successor not under this grant
  | "predecessor_live";  // the from-session is not ended (not terminal)

export interface RebindTaskLeaseInput {
  lease_id: string;
  expected_epoch: number;
  from_agent_session_id: string;
  to_agent_session_id: string;
  supervisor_grant_fence: SupervisorGrantFence;
}

export type RebindTaskLeaseResult =
  | { ok: true; lease: TaskLease }
  | { ok: false; reason: RebindTaskLeaseFailure };

export async function rebindTaskLease(input: RebindTaskLeaseInput): Promise<RebindTaskLeaseResult> {
  return db.transaction(async (tx) => {
    // Serialize concurrent rebinds of the same lease so the epoch CAS below has
    // exactly one winner even under simultaneous supervisor attempts.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task_lease:${input.lease_id}`}, 0))`);

    // Authority: the supervisor grant must be current (generation + token
    // version + not revoked/expired). Same agent_key alone is never enough.
    if (!(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
      return { ok: false, reason: "grant_fence_stale" as const };
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
    if (!lease) return { ok: false, reason: "lost_race" as const };

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
      return { ok: false, reason: "grant_scope" as const };
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
      return { ok: false, reason: "session_mismatch" as const };
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
      return { ok: false, reason: "session_mismatch" as const };
    }

    // The predecessor must be genuinely terminal: its session is ended (which
    // also revokes its bearer). Delivery-unreachability is NOT termination — a
    // live worker between long-poll reconnects has no delivery row — so we do
    // not wrest a lease on reachability alone. (Attempt-level terminal state
    // from P1b can later widen this; session-ended is the conservative floor.)
    if (!fromSession.ended_at) {
      return { ok: false, reason: "predecessor_live" as const };
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

    // Fenced rebind: repoint the lease to the successor and bump the epoch. The
    // WHERE clause re-asserts the CAS predicate so a racing writer that slipped
    // between the SELECT and here cannot double-apply.
    const [updated] = await tx
      .update(task_leases)
      .set({
        agent_session_id: input.to_agent_session_id,
        agent_key: toSession.agent_key,
        agent_instance_id: toSession.agent_instance_id ?? null,
        actor_label: toSession.actor_label,
        epoch: lease.epoch + 1,
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
    if (!updated) return { ok: false, reason: "lost_race" as const };

    return { ok: true, lease: toTaskLease(updated as TaskLeaseRow) };
  });
}

// A lease-guarded write may re-verify that the caller still holds the exact
// lease epoch it last observed. After a rebind the epoch has advanced, so a
// partitioned-but-live predecessor that somehow still authenticates is rejected
// here even before actor/session identity is considered.
export async function assertLeaseEpochCurrentTx(
  tx: any,
  input: { lease_id: string; expected_epoch: number; agent_session_id: string },
): Promise<boolean> {
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
