import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { hasAgentProcessExited } from "../../../shared/agent-presence.js";
import { isMcpWorkerId } from "../../../shared/mcp-worker.js";
import { agentDisplayNameKey } from "../../rooms/agent-display-name-allocation.js";
import { coordination_events, room_agent_sessions, task_leases, tasks } from "../schema.js";
import type { TaskLeaseKind, TaskLeaseStatus } from "../types.js";
import { coordinationId } from "../utils.js";

/**
 * A session that registers again under another label is the same agent, and
 * its work is still its own: ownership is by identity. But the board names
 * the agent by its label, and its leases carry the label, so a renamed agent
 * would be shown at work under a name that may now be another's.
 */
export async function relabelTaskWorkTx(
  tx: any,
  input: {
    room_id: string;
    agent_key: string;
    session_id: string;
    actor_label: string;
    now: string;
  },
): Promise<void> {
  const [held] = await Promise.all([
    tx.update(task_leases)
      .set({ actor_label: input.actor_label, updated_at: input.now })
      .where(and(
        eq(task_leases.room_id, input.room_id),
        eq(task_leases.agent_key, input.agent_key),
        eq(task_leases.agent_session_id, input.session_id),
        eq(task_leases.status, "active" as TaskLeaseStatus),
        ne(task_leases.actor_label, input.actor_label),
      ))
      .returning({ id: task_leases.id }),
    tx.update(tasks)
      .set({ assignee: input.actor_label })
      .where(and(
        eq(tasks.room_id, input.room_id),
        eq(tasks.assignee_agent_key, input.agent_key),
        inArray(tasks.status, [...OPEN_ASSIGNED_STATUSES]),
        ne(tasks.assignee, input.actor_label),
      )),
  ]);
  void held;
}

export interface AdoptedTaskLease {
  lease_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  from_agent_session_id: string;
  from_agent_key: string;
}

/** Statuses in which a task is an agent's to move forward. */
const OPEN_ASSIGNED_STATUSES = ["assigned", "in_progress", "blocked", "in_review"] as const;

/**
 * A lease is held by a session, and a session does not outlive its process.
 * An agent that starts again registers a new session, and its lease would
 * stay with the old one: the agent could neither advance its task nor claim
 * it again, and nobody else could either.
 *
 * So what an ended session held passes to the session that carries its agent
 * on. Two things can show that a session does:
 *
 * - It is the same process registering again under the same identity.
 * - The process that held the lease is known to have exited, and the session
 *   now registering is the same agent. That is one registered under the same
 *   identity. It is also one that holds the agent's name, when the identity
 *   that had the name has no session left in the room: an agent registered
 *   without a durable handle is given a new identity by every process it
 *   runs in, so its name is all that says it is the same agent. A durable
 *   worker's identity outlives its process, and it comes back to its own
 *   row: its name may pass on while it is away, but its work waits for it.
 *   (An agent that fixes its name with LETAGENTS_AGENT_NAME keeps its
 *   identity too, and the room cannot tell it from one that does not; its
 *   work follows its name.)
 *
 * Exit must be known, not supposed. A name may pass on from an agent that
 * was only silent for long enough, because an agent wrongly taken for gone
 * loses a name and registers again. Work taken from it could not be given
 * back, so silence moves none.
 *
 * Nothing passes from a session that is still live, from another owner's
 * agent, or from a session a room admin disconnected: that takes the work
 * away from the agent, and it stays behind for the admin to release. A
 * review passes only within one identity: another identity asks to review
 * in its own right, and the two do not contend for one lease.
 *
 * A supervised worker is started by its supervisor, which registers each
 * process it starts for the agent under the grant it holds, and runs one
 * process per agent at a time. Its work passes only when that supervisor
 * registers the same agent again: the same grant, the same identity and the
 * same agent instance, from an ended session created before the receiving
 * one. The ended session's credentials were revoked with it, so the work has
 * one holder. A registration keeps the oldest live session and ends any
 * newer duplicate, so a session still live when it began passes nothing,
 * even one it ends itself. Creation order, unlike end times, outlasts any
 * difference between the clocks of the servers that wrote it. A name never
 * carries work from one supervised agent to another.
 *
 * Runs inside the registration's transaction. A lease that something else is
 * writing to is skipped, not waited for, and is adopted at the agent's next
 * registration: waiting here could hold a registration behind a task write
 * that is itself waiting on this registration's sessions, or past the
 * deadline of a supervisor waiting for its worker's credentials.
 */
export async function adoptTaskLeasesFromEndedSessionsTx(
  tx: any,
  input: {
    room_id: string;
    agent_key: string;
    owner_account_id: string;
    /** Set when the supervisor holding this grant registers the successor. */
    supervisor_grant_id?: string | null;
    successor: {
      session_id: string;
      agent_instance_id: string | null;
      actor_label: string;
      display_name: string;
      process_host_id: string | null;
      /** When the receiving session was created. Required with a grant. */
      created_at?: string;
    };
    now: string;
  },
): Promise<AdoptedTaskLease[]> {
  const supervisedBy = input.supervisor_grant_id ?? null;
  if (supervisedBy && (!input.successor.agent_instance_id || !input.successor.created_at)) return [];
  const held = await tx
    .select({
      id: task_leases.id,
      task_id: task_leases.task_id,
      kind: task_leases.kind,
      epoch: task_leases.epoch,
      agent_key: task_leases.agent_key,
      agent_session_id: task_leases.agent_session_id,
      holder: {
        display_name: room_agent_sessions.display_name,
        agent_instance_id: room_agent_sessions.agent_instance_id,
        ended_at: room_agent_sessions.ended_at,
        last_seen_at: room_agent_sessions.last_seen_at,
        agent_heard_at: room_agent_sessions.agent_heard_at,
        process_seen_at: room_agent_sessions.process_seen_at,
        process_connection_id: room_agent_sessions.process_connection_id,
        process_disconnected_at: room_agent_sessions.process_disconnected_at,
        process_host_id: room_agent_sessions.process_host_id,
      },
    })
    .from(task_leases)
    .innerJoin(room_agent_sessions, eq(room_agent_sessions.session_id, task_leases.agent_session_id))
    .where(and(
      eq(task_leases.room_id, input.room_id),
      eq(task_leases.status, "active" as TaskLeaseStatus),
      sql`(${task_leases.expires_at} IS NULL OR ${task_leases.expires_at} > ${input.now}::timestamptz)`,
      ne(task_leases.agent_session_id, input.successor.session_id),
      eq(room_agent_sessions.room_id, input.room_id),
      eq(room_agent_sessions.agent_key, task_leases.agent_key),
      eq(room_agent_sessions.owner_account_id, input.owner_account_id),
      eq(room_agent_sessions.session_kind, "worker"),
      isNotNull(room_agent_sessions.ended_at),
      sql`${room_agent_sessions.end_reason} IS DISTINCT FROM 'room_admin'`,
      ...(supervisedBy ? [
        // Only this agent, started again by the same supervisor, and only
        // what an older session held. With the two above, these are the
        // whole test for a supervised worker.
        eq(room_agent_sessions.supervisor_grant_id, supervisedBy),
        eq(task_leases.agent_key, input.agent_key),
        eq(room_agent_sessions.agent_instance_id, input.successor.agent_instance_id!),
        sql`${room_agent_sessions.created_at} < ${input.successor.created_at!}::timestamptz`,
      ] : [isNull(room_agent_sessions.supervisor_grant_id)]),
    ))
    .orderBy(asc(task_leases.id)) as Array<{
      id: string; task_id: string; kind: TaskLeaseKind; epoch: number;
      agent_key: string; agent_session_id: string;
      holder: {
        display_name: string; agent_instance_id: string | null; ended_at: string | null;
        last_seen_at: string; agent_heard_at: string | null; process_seen_at: string | null;
        process_connection_id: string | null; process_disconnected_at: string | null;
        process_host_id: string | null;
      };
    }>;
  if (held.length === 0) return [];

  // An identity that still has a session in the room is still there, under
  // whatever name. What it held is its own to take up again.
  const otherKeys = [...new Set(held.map((lease) => lease.agent_key))].filter((key) => key !== input.agent_key);
  const stillThere = new Set<string>(otherKeys.length === 0 ? [] : (await tx
    .selectDistinct({ agent_key: room_agent_sessions.agent_key })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, input.room_id),
      inArray(room_agent_sessions.agent_key, otherKeys),
      isNull(room_agent_sessions.ended_at),
    )) as Array<{ agent_key: string }>).map((row) => row.agent_key));
  const observer = { now_ms: Date.parse(input.now), process_host_id: input.successor.process_host_id };
  const nameKey = agentDisplayNameKey(input.successor.display_name);
  const carriedOn = (lease: (typeof held)[number]): boolean => {
    if (supervisedBy) return true;
    const sameIdentity = lease.agent_key === input.agent_key;
    if (sameIdentity && Boolean(input.successor.agent_instance_id)
      && lease.holder.agent_instance_id === input.successor.agent_instance_id) return true;
    if (!hasAgentProcessExited(lease.holder, observer)) return false;
    if (sameIdentity) return true;
    return lease.kind === "work" && Boolean(nameKey)
      && !isMcpWorkerId(lease.holder.agent_instance_id)
      && agentDisplayNameKey(lease.holder.display_name) === nameKey
      && !stillThere.has(lease.agent_key);
  };

  const adopted: AdoptedTaskLease[] = [];
  for (const lease of held) {
    if (!carriedOn(lease)) continue;
    // The same lock every lease-guarded write and every rebind takes.
    const locked = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`task_lease:${lease.id}`}, 0)) AS locked`,
    );
    if (!(locked.rows?.[0] as { locked?: boolean } | undefined)?.locked) continue;
    // Not every writer takes that lock first: an expiry sweep, a plain task
    // update and a review verdict's effect journal lock these rows directly.
    // Lock them in the usual order, lease then task, and skip the lease if
    // either is held, rather than wait.
    const [leaseRow] = await tx.select({ id: task_leases.id })
      .from(task_leases)
      .where(and(
        eq(task_leases.id, lease.id),
        eq(task_leases.status, "active" as TaskLeaseStatus),
        eq(task_leases.epoch, lease.epoch),
        eq(task_leases.agent_session_id, lease.agent_session_id),
      ))
      .for("no key update", { skipLocked: true });
    if (!leaseRow) continue;
    const taskNumber = /^task_(\d+)$/.exec(lease.task_id)?.[1];
    if (lease.kind === "work" && taskNumber) {
      const [taskRow] = await tx.select({ number: tasks.number })
        .from(tasks)
        .where(and(eq(tasks.room_id, input.room_id), eq(tasks.number, Number(taskNumber))))
        .for("no key update", { skipLocked: true });
      if (!taskRow) continue;
    }
    const [moved] = await tx.update(task_leases)
      .set({
        agent_key: input.agent_key,
        agent_session_id: input.successor.session_id,
        agent_instance_id: input.successor.agent_instance_id,
        actor_label: input.successor.actor_label,
        // A work lease fences what was written under the old session's
        // authority, as it does when a supervisor moves it. A review lease
        // has no such fence, and its epoch stays as every reader expects.
        epoch: lease.kind === "work" ? lease.epoch + 1 : lease.epoch,
        updated_at: input.now,
        last_heartbeat_at: input.now,
      })
      .where(and(
        eq(task_leases.id, lease.id),
        eq(task_leases.status, "active" as TaskLeaseStatus),
        eq(task_leases.epoch, lease.epoch),
        eq(task_leases.agent_session_id, lease.agent_session_id),
      ))
      .returning({ id: task_leases.id });
    if (!moved) continue;
    adopted.push({
      lease_id: lease.id, task_id: lease.task_id, kind: lease.kind,
      from_agent_session_id: lease.agent_session_id, from_agent_key: lease.agent_key,
    });
    if (lease.kind === "work" && taskNumber) {
      // The task is assigned to the identity and the label that held the
      // lease. It goes where the lease went, or the agent could hold the
      // lease and still be refused the task, and the board would name an
      // agent that is no longer the one working.
      await tx.update(tasks)
        .set({ assignee_agent_key: input.agent_key, assignee: input.successor.actor_label })
        .where(and(
          eq(tasks.room_id, input.room_id),
          eq(tasks.number, Number(taskNumber)),
          eq(tasks.assignee_agent_key, lease.agent_key),
          inArray(tasks.status, [...OPEN_ASSIGNED_STATUSES]),
        ));
    }
    await tx.insert(coordination_events).values({
      id: coordinationId("ce"),
      room_id: input.room_id,
      task_id: lease.task_id,
      lease_id: lease.id,
      lock_id: null,
      event_type: "lease_adopt",
      decision: "record",
      actor_label: input.successor.actor_label,
      actor_key: input.agent_key,
      actor_instance_id: input.successor.agent_instance_id,
      reason: supervisedBy
        ? "The session that held this lease ended; its supervisor started the agent again, and the lease passed to the new session."
        : "The session that held this lease ended; it passed to the session that carries its agent on.",
      metadata: {
        from_agent_session_id: lease.agent_session_id,
        from_agent_key: lease.agent_key,
        to_agent_session_id: input.successor.session_id,
        ...(supervisedBy ? { supervisor_grant_id: supervisedBy } : {}),
      },
      created_at: input.now,
    });
  }
  return adopted;
}
