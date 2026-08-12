import { and, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { toRoomAgentLivenessObservation, toRoomAgentPresence } from "../mappers.js";
import {
  room_agent_delivery_sessions,
  room_agent_liveness_observations,
  room_agent_presence,
  room_agent_sessions,
  task_leases,
} from "../schema.js";
import type { RoomAgentLivenessObservation, RoomAgentLivenessObservationRow, RoomAgentPresence, RoomAgentPresenceRow } from "../types.js";
import type { AgentPresenceStatus } from "../../../shared/agent-presence.js";

class StaleNativePresenceOwnerError extends Error {}

type LivenessDeliveryScheduler = Pick<typeof db, "update">;

async function scheduleNativeHarnessDeliveryCheck(
  executor: LivenessDeliveryScheduler,
  input: { room_id: string; agent_session_id: string; observed_at: string },
): Promise<void> {
  await executor.update(room_agent_delivery_sessions)
    .set({ next_liveness_check_at: new Date(Date.parse(input.observed_at) + 5 * 60_000).toISOString() })
    .where(and(
      eq(room_agent_delivery_sessions.room_id, input.room_id),
      eq(room_agent_delivery_sessions.agent_session_id, input.agent_session_id),
      eq(room_agent_delivery_sessions.session_kind, "worker"),
    ));
}

/**
 * Rendered presence outlives a worker session so room history does not blink
 * away during recovery. A successor may inherit that projection only when it
 * is the exact active worker for the same durable agent and the prior owner is
 * no longer active. Keeping this as one SQL predicate makes the handoff atomic:
 * a concurrent predecessor cannot become active between a read and the write.
 */
function nativePresenceOwnerFence(input: {
  room_id: string;
  agent_session_id: string;
  agent_key: string;
}) {
  return sql`
    ${room_agent_presence.agent_session_id} IS NULL
    OR ${room_agent_presence.agent_session_id} = ${input.agent_session_id}
    OR (
      ${room_agent_presence.agent_key} = ${input.agent_key}
      AND EXISTS (
        SELECT 1
        FROM ${room_agent_sessions} AS successor_session
        WHERE successor_session.session_id = ${input.agent_session_id}
          AND successor_session.room_id = ${input.room_id}
          AND successor_session.agent_key = ${input.agent_key}
          AND successor_session.session_kind = 'worker'
          AND successor_session.ended_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${room_agent_sessions} AS predecessor_session
        WHERE predecessor_session.session_id = ${room_agent_presence.agent_session_id}
          AND predecessor_session.room_id = ${input.room_id}
          AND predecessor_session.agent_key = ${input.agent_key}
          AND predecessor_session.session_kind = 'worker'
          AND predecessor_session.ended_at IS NULL
      )
    )
  `;
}

/**
 * A native activity heartbeat proves that the provider connection is alive;
 * it must not manufacture work.  Preserve the validated provider status and
 * give an idle heartbeat a human-readable listening label.
 */
export function nativeHarnessPresenceForStatus(status: AgentPresenceStatus): {
  status: AgentPresenceStatus;
  status_text: string;
} {
  switch (status) {
    case "idle":
      return { status, status_text: "Connected — listening" };
    case "reviewing":
      return { status, status_text: "Reviewing" };
    case "blocked":
      return { status, status_text: "Needs attention" };
    case "working":
      return { status, status_text: "Working" };
  }
}

export async function upsertRoomAgentLivenessObservation(input: {
  room_id: string;
  agent_session_id: string;
  source?: string | null;
  host_id?: string | null;
  host_kind?: string | null;
  host_label?: string | null;
  liveness_capability?: string | null;
  tool_bridge_id?: string | null;
  last_observed_at?: string | null;
  last_tool_call_at?: string | null;
  detail?: string | null;
}): Promise<RoomAgentLivenessObservation> {
  const now = new Date().toISOString();
  const lastObservedAt = input.last_observed_at ?? now;
  const source = input.source?.trim() || "agent_session";

  const [observation] = await db
    .insert(room_agent_liveness_observations)
    .values({
      room_id: input.room_id,
      agent_session_id: input.agent_session_id,
      source,
      host_id: input.host_id ?? null,
      host_kind: input.host_kind ?? null,
      host_label: input.host_label ?? null,
      liveness_capability: input.liveness_capability?.trim() || "session_activity",
      tool_bridge_id: input.tool_bridge_id ?? null,
      last_observed_at: lastObservedAt,
      last_tool_call_at: input.last_tool_call_at ?? lastObservedAt,
      detail: input.detail ?? null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        room_agent_liveness_observations.room_id,
        room_agent_liveness_observations.agent_session_id,
        room_agent_liveness_observations.source,
      ],
      set: {
        host_id: input.host_id ?? null,
        host_kind: input.host_kind ?? null,
        host_label: input.host_label ?? null,
        liveness_capability: input.liveness_capability?.trim() || "session_activity",
        tool_bridge_id: input.tool_bridge_id ?? null,
        last_observed_at: lastObservedAt,
        last_tool_call_at: input.last_tool_call_at ?? lastObservedAt,
        detail: input.detail ?? null,
        updated_at: now,
      },
      // Native/provider streams are ordered at their source. A delayed HTTP
      // retry must not move an axis backwards and manufacture staleness.
      setWhere: sql`${room_agent_liveness_observations.last_observed_at} < ${lastObservedAt}::timestamptz`,
    })
    .returning();
  let resolved = observation;
  if (!resolved) {
    const [current] = await db.select().from(room_agent_liveness_observations).where(and(
      eq(room_agent_liveness_observations.room_id, input.room_id),
      eq(room_agent_liveness_observations.agent_session_id, input.agent_session_id),
      eq(room_agent_liveness_observations.source, source),
    )).limit(1);
    if (!current) throw new Error("Liveness observation disappeared during an ordered upsert.");
    resolved = current;
  }
  if (source === "native_harness" && observation) {
    // Native work can remain active while room delivery is quiet. Push the
    // same due record so the indexed sweep wakes only when both axes may be
    // stale, instead of rechecking it every minute while work continues.
    await scheduleNativeHarnessDeliveryCheck(db, {
      room_id: input.room_id,
      agent_session_id: input.agent_session_id,
      observed_at: now,
    });
  }
  return toRoomAgentLivenessObservation(resolved as RoomAgentLivenessObservationRow);
}

/**
 * Refresh every active lease held by this exact worker session. Each write is
 * CAS-fenced on the epoch read inside the transaction, so a concurrent rebind
 * wins cleanly and the stale native stream cannot heartbeat the successor.
 */
export async function heartbeatNativeHarnessTaskLeases(input: {
  room_id: string;
  agent_session_id: string;
}): Promise<Array<{ id: string; epoch: number }>> {
  const observedAt = new Date().toISOString();
  return db.transaction(async (tx) => {
    const held = await tx.select({ id: task_leases.id, epoch: task_leases.epoch }).from(task_leases).where(and(
      eq(task_leases.room_id, input.room_id),
      eq(task_leases.agent_session_id, input.agent_session_id),
      eq(task_leases.kind, "work"),
      eq(task_leases.status, "active"),
    ));
    const touched: Array<{ id: string; epoch: number }> = [];
    for (const lease of held) {
      const [row] = await tx.update(task_leases).set({ last_heartbeat_at: observedAt, updated_at: observedAt }).where(and(
        eq(task_leases.id, lease.id),
        eq(task_leases.room_id, input.room_id),
        eq(task_leases.agent_session_id, input.agent_session_id),
        eq(task_leases.kind, "work"),
        eq(task_leases.status, "active"),
        eq(task_leases.epoch, lease.epoch),
        sql`(${task_leases.last_heartbeat_at} IS NULL OR ${task_leases.last_heartbeat_at} < ${observedAt}::timestamptz)`,
      )).returning({ id: task_leases.id, epoch: task_leases.epoch });
      if (row) touched.push(row);
    }
    return touched;
  });
}

/**
 * Atomically publishes the native axis, rendered provider presence, and the
 * exact worker's work-lease heartbeat. Provider time orders observations only;
 * every server-owned freshness write uses one server timestamp.
 */
export async function recordNativeHarnessActivity(input: {
  room_id: string;
  agent_session_id: string;
  actor_label: string;
  agent_key: string;
  session_kind: "worker";
  runtime: string;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  repo_branch: string | null;
  provider_observed_at: string;
  sequence: number;
  method: string;
  status: AgentPresenceStatus;
}): Promise<{
  observation: RoomAgentLivenessObservation | null;
  presence: RoomAgentPresence | null;
  lease_heartbeats: Array<{ id: string; epoch: number }>;
  accepted: boolean;
}> {
  const serverNow = new Date().toISOString();
  try {
    return await db.transaction(async (tx) => {
    const detail = JSON.stringify({
      provider_observed_at: input.provider_observed_at,
      sequence: input.sequence,
      method: input.method,
      status: input.status,
    }).slice(0, 500);
    const [insertedObservation] = await tx.insert(room_agent_liveness_observations).values({
      room_id: input.room_id,
      agent_session_id: input.agent_session_id,
      source: "native_harness",
      host_id: null,
      host_kind: "native_harness",
      host_label: input.ide_label,
      liveness_capability: "native_provider_stream",
      tool_bridge_id: null,
      last_observed_at: input.provider_observed_at,
      last_tool_call_at: serverNow,
      detail,
      created_at: serverNow,
      updated_at: serverNow,
    }).onConflictDoUpdate({
      target: [
        room_agent_liveness_observations.room_id,
        room_agent_liveness_observations.agent_session_id,
        room_agent_liveness_observations.source,
      ],
      set: {
        host_id: null,
        host_kind: "native_harness",
        host_label: input.ide_label,
        liveness_capability: "native_provider_stream",
        tool_bridge_id: null,
        last_observed_at: input.provider_observed_at,
        last_tool_call_at: serverNow,
        detail,
        updated_at: serverNow,
      },
      setWhere: sql`${room_agent_liveness_observations.last_observed_at} < ${input.provider_observed_at}::timestamptz
        AND COALESCE((${room_agent_liveness_observations.detail}::jsonb ->> 'sequence')::bigint, 0) < ${input.sequence}`,
    }).returning();

    let observationRow = insertedObservation;
    if (!observationRow) {
      [observationRow] = await tx.select().from(room_agent_liveness_observations).where(and(
        eq(room_agent_liveness_observations.room_id, input.room_id),
        eq(room_agent_liveness_observations.agent_session_id, input.agent_session_id),
        eq(room_agent_liveness_observations.source, "native_harness"),
      )).limit(1);
    }
    if (!observationRow) throw new Error("Native liveness observation disappeared during ordered update.");
    if (!insertedObservation) {
      return {
        observation: toRoomAgentLivenessObservation(observationRow as RoomAgentLivenessObservationRow),
        presence: null,
        lease_heartbeats: [],
        accepted: false,
      };
    }

    const presence = nativeHarnessPresenceForStatus(input.status);
    const [presenceRow] = await tx.insert(room_agent_presence).values({
      room_id: input.room_id,
      actor_label: input.actor_label,
      agent_key: input.agent_key,
      agent_session_id: input.agent_session_id,
      session_kind: input.session_kind,
      runtime: input.runtime,
      display_name: input.display_name,
      owner_label: input.owner_label,
      ide_label: input.ide_label,
      repo_branch: input.repo_branch,
      status: presence.status,
      status_text: presence.status_text,
      last_heartbeat_at: serverNow,
      created_at: serverNow,
      updated_at: serverNow,
    }).onConflictDoUpdate({
      target: [room_agent_presence.room_id, room_agent_presence.actor_label],
      set: {
        agent_key: input.agent_key,
        agent_session_id: input.agent_session_id,
        session_kind: input.session_kind,
        runtime: input.runtime,
        display_name: input.display_name,
        owner_label: input.owner_label,
        ide_label: input.ide_label,
        repo_branch: input.repo_branch,
        status: presence.status,
        status_text: presence.status_text,
        last_heartbeat_at: serverNow,
        updated_at: serverNow,
      },
      setWhere: nativePresenceOwnerFence(input),
    }).returning();
    if (!presenceRow) throw new StaleNativePresenceOwnerError("A newer worker session owns this actor's rendered presence.");

    await scheduleNativeHarnessDeliveryCheck(tx, {
      room_id: input.room_id,
      agent_session_id: input.agent_session_id,
      observed_at: serverNow,
    });

    const held = await tx.select({ id: task_leases.id, epoch: task_leases.epoch }).from(task_leases).where(and(
      eq(task_leases.room_id, input.room_id),
      eq(task_leases.agent_session_id, input.agent_session_id),
      eq(task_leases.kind, "work"),
      eq(task_leases.status, "active"),
    ));
    const leases: Array<{ id: string; epoch: number }> = [];
    for (const lease of held) {
      const [row] = await tx.update(task_leases).set({ last_heartbeat_at: serverNow, updated_at: serverNow }).where(and(
        eq(task_leases.id, lease.id),
        eq(task_leases.room_id, input.room_id),
        eq(task_leases.agent_session_id, input.agent_session_id),
        eq(task_leases.kind, "work"),
        eq(task_leases.status, "active"),
        eq(task_leases.epoch, lease.epoch),
      )).returning({ id: task_leases.id, epoch: task_leases.epoch });
      if (row) leases.push(row);
    }
    return {
      observation: toRoomAgentLivenessObservation(observationRow as RoomAgentLivenessObservationRow),
      presence: toRoomAgentPresence(presenceRow as RoomAgentPresenceRow),
      lease_heartbeats: leases,
      accepted: true,
    };
    });
  } catch (error) {
    if (!(error instanceof StaleNativePresenceOwnerError)) throw error;
    const [[observationRow], [presenceRow]] = await Promise.all([
      db.select().from(room_agent_liveness_observations).where(and(
        eq(room_agent_liveness_observations.room_id, input.room_id),
        eq(room_agent_liveness_observations.agent_session_id, input.agent_session_id),
        eq(room_agent_liveness_observations.source, "native_harness"),
      )).limit(1),
      db.select().from(room_agent_presence).where(and(
        eq(room_agent_presence.room_id, input.room_id),
        eq(room_agent_presence.actor_label, input.actor_label),
      )).limit(1),
    ]);
    return {
      observation: observationRow ? toRoomAgentLivenessObservation(observationRow as RoomAgentLivenessObservationRow) : null,
      presence: presenceRow ? toRoomAgentPresence(presenceRow as RoomAgentPresenceRow) : null,
      lease_heartbeats: [],
      accepted: false,
    };
  }
}
