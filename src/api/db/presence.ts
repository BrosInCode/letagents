import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import { ACTIVE_AGENT_DELIVERY_WINDOW_MS, getAgentPresenceFreshnessFromReachability, isAgentDeliverySessionReachable, ROOM_AGENT_RECONNECT_GRACE_MS, type AgentPresenceStatus, type RoomAgentDeliveryTransport, type RoomAgentSessionKind } from "../../shared/agent-presence.js";
import { buildRoomActivitySourceFlags, deriveRoomAgentActivityState, isWithinRecentlyOfflineWindow, RECENTLY_OFFLINE_MAX_AGENTS, RECENTLY_OFFLINE_WINDOW_MS } from "../../shared/room-agent-activity.js";
import { db } from "./client.js";
import { room_agent_delivery_sessions, room_agent_liveness_observations, room_agent_presence, room_live_agent_suppressions } from "./schema.js";
import { clampLimit, MAX_LIST_LIMIT } from "./utils.js";
import { toRoomAgentDeliverySession, toRoomAgentLivenessObservation, toRoomAgentPresence } from "./mappers.js";
import { touchRoomAgentSession } from "./auth.js";
import type { RoomAgentDeliverySession, RoomAgentDeliverySessionRow, RoomAgentLivenessObservation, RoomAgentLivenessObservationRow, RoomAgentPresence, RoomAgentPresenceRow } from "./types.js";

export function normalizeRoomActorLabel(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function isRoomAgentDeliverySessionReachable(
  session: Pick<RoomAgentDeliverySession, "active_connection_count" | "updated_at" | "reconnect_grace_expires_at">,
  now = Date.now()
): boolean {
  return isAgentDeliverySessionReachable({
    activeConnectionCount: session.active_connection_count,
    updatedAt: session.updated_at,
    reconnectGraceExpiresAt: session.reconnect_grace_expires_at,
  }, now);
}

export function getRoomAgentDeliverySessionLastSeenAt(
  session: Pick<RoomAgentDeliverySession, "last_connected_at" | "last_disconnected_at" | "updated_at">
): string {
  return session.last_disconnected_at ?? session.updated_at ?? session.last_connected_at;
}

export function mergeRoomAgentPresenceRecords(input: {
  roomId: string;
  statusEntries: readonly RoomAgentPresence[];
  deliverySessions: readonly RoomAgentDeliverySession[];
  livenessObservations?: readonly RoomAgentLivenessObservation[];
  now?: number;
}): RoomAgentPresence[] {
  const now = input.now ?? Date.now();
  const statusByActor = new Map(input.statusEntries.map((entry) => [entry.actor_label, entry]));
  const livenessBySession = new Map<string, RoomAgentLivenessObservation>();
  for (const entry of input.livenessObservations ?? []) {
    const existing = livenessBySession.get(entry.agent_session_id);
    if (!existing || Date.parse(entry.last_observed_at) > Date.parse(existing.last_observed_at)) {
      livenessBySession.set(entry.agent_session_id, entry);
    }
  }
  const statusActorsWithDelivery = new Set<string>();

  const buildEntry = (
    actorLabel: string,
    statusEntry: RoomAgentPresence | null,
    deliverySession: RoomAgentDeliverySession | null
  ): RoomAgentPresence => {
    const isReachable = deliverySession
      ? isRoomAgentDeliverySessionReachable(deliverySession, now)
      : false;
    const status = statusEntry?.status ?? "idle";
    const agentSessionId = deliverySession?.agent_session_id ?? statusEntry?.agent_session_id ?? null;
    const lastSeenAt = deliverySession
      ? getRoomAgentDeliverySessionLastSeenAt(deliverySession)
      : statusEntry?.last_heartbeat_at ?? new Date(0).toISOString();

    return {
      room_id: input.roomId,
      actor_label: actorLabel,
      agent_key: deliverySession?.agent_key ?? statusEntry?.agent_key ?? null,
      agent_instance_id: deliverySession?.agent_instance_id ?? statusEntry?.agent_instance_id ?? null,
      agent_session_id: agentSessionId,
      session_kind: deliverySession?.session_kind ?? statusEntry?.session_kind ?? "controller",
      runtime: deliverySession?.runtime ?? statusEntry?.runtime ?? "unknown",
      display_name: deliverySession?.display_name ?? statusEntry?.display_name ?? actorLabel,
      owner_label: deliverySession?.owner_label ?? statusEntry?.owner_label ?? null,
      ide_label: deliverySession?.ide_label ?? statusEntry?.ide_label ?? null,
      status,
      status_text: statusEntry?.status_text ?? null,
      last_heartbeat_at: lastSeenAt,
      created_at: statusEntry?.created_at ?? deliverySession?.created_at ?? lastSeenAt,
      updated_at: deliverySession?.updated_at ?? statusEntry?.updated_at ?? lastSeenAt,
      freshness: getAgentPresenceFreshnessFromReachability(isReachable),
      activity_state: deriveRoomAgentActivityState({
        hidden: false,
        hasPresence: Boolean(statusEntry || deliverySession),
        freshness: getAgentPresenceFreshnessFromReachability(isReachable),
        status: deliverySession ? status : "idle",
      }),
      source_flags: buildRoomActivitySourceFlags([
        deliverySession ? "delivery" : null,
        statusEntry ? "presence" : null,
      ]),
      liveness_observation: agentSessionId ? livenessBySession.get(agentSessionId) ?? null : null,
    } satisfies RoomAgentPresence;
  };

  const merged: RoomAgentPresence[] = [];
  for (const deliverySession of input.deliverySessions) {
    const actorLabel = deliverySession.actor_label;
    statusActorsWithDelivery.add(actorLabel);
    merged.push(buildEntry(actorLabel, statusByActor.get(actorLabel) ?? null, deliverySession));
  }
  for (const statusEntry of input.statusEntries) {
    if (statusActorsWithDelivery.has(statusEntry.actor_label)) {
      continue;
    }
    merged.push(buildEntry(statusEntry.actor_label, statusEntry, null));
  }

  return merged.sort((left, right) => {
    if (left.freshness !== right.freshness) {
      return left.freshness === "active" ? -1 : 1;
    }

    const leftSeenAt = Date.parse(left.last_heartbeat_at);
    const rightSeenAt = Date.parse(right.last_heartbeat_at);
    if (Number.isFinite(leftSeenAt) && Number.isFinite(rightSeenAt) && leftSeenAt !== rightSeenAt) {
      return rightSeenAt - leftSeenAt;
    }

    return left.display_name.localeCompare(right.display_name);
  });
}

export function filterRoomAgentPresenceForLiveRoster(input: {
  presence: readonly RoomAgentPresence[];
  suppressedActors?: ReadonlySet<string>;
  limit: number;
  staleLimit?: number;
  staleWithinMs?: number;
  now?: number;
}): RoomAgentPresence[] {
  const now = input.now ?? Date.now();
  const staleLimit = Math.max(0, Math.min(input.staleLimit ?? RECENTLY_OFFLINE_MAX_AGENTS, input.limit));
  const staleWithinMs = input.staleWithinMs ?? RECENTLY_OFFLINE_WINDOW_MS;
  const active: RoomAgentPresence[] = [];
  const stale: RoomAgentPresence[] = [];

  for (const entry of input.presence) {
    if (entry.session_kind !== "worker") {
      continue;
    }

    if (entry.freshness === "active") {
      active.push(entry);
      continue;
    }

    const actorLabel = normalizeRoomActorLabel(entry.actor_label);
    if (actorLabel && input.suppressedActors?.has(actorLabel)) {
      continue;
    }

    if (!isWithinRecentlyOfflineWindow(entry.last_heartbeat_at, now, staleWithinMs)) {
      continue;
    }

    if (!entry.source_flags.includes("delivery")) {
      continue;
    }

    stale.push(entry);
  }

  const boundedActive = active.slice(0, input.limit);
  const remaining = Math.max(input.limit - boundedActive.length, 0);
  return [
    ...boundedActive,
    ...stale.slice(0, Math.min(staleLimit, remaining)),
  ];
}

export async function getMergedRoomAgentPresenceRecords(
  roomId: string,
  options?: { statusLimit?: number; deliveryLimit?: number }
): Promise<RoomAgentPresence[]> {
  const statusQuery = db
    .select()
    .from(room_agent_presence)
    .where(eq(room_agent_presence.room_id, roomId))
    .orderBy(desc(room_agent_presence.last_heartbeat_at), asc(room_agent_presence.display_name));

  const deliveryQuery = db
    .select()
    .from(room_agent_delivery_sessions)
    .where(eq(room_agent_delivery_sessions.room_id, roomId))
    .orderBy(
      desc(room_agent_delivery_sessions.updated_at),
      desc(room_agent_delivery_sessions.active_connection_count),
      desc(room_agent_delivery_sessions.last_connected_at),
      asc(room_agent_delivery_sessions.display_name)
    );

  const livenessQuery = db
    .select()
    .from(room_agent_liveness_observations)
    .where(eq(room_agent_liveness_observations.room_id, roomId))
    .orderBy(desc(room_agent_liveness_observations.last_observed_at))
    .limit(Math.max(options?.deliveryLimit ?? options?.statusLimit ?? 50, 200));

  const [statusRows, deliveryRows, livenessRows] = await Promise.all([
    options?.statusLimit ? statusQuery.limit(options.statusLimit) : statusQuery,
    options?.deliveryLimit ? deliveryQuery.limit(options.deliveryLimit) : deliveryQuery,
    livenessQuery,
  ]);

  return mergeRoomAgentPresenceRecords({
    roomId,
    statusEntries: (statusRows as RoomAgentPresenceRow[]).map(toRoomAgentPresence),
    deliverySessions: (deliveryRows as RoomAgentDeliverySessionRow[]).map(toRoomAgentDeliverySession),
    livenessObservations: (livenessRows as RoomAgentLivenessObservationRow[]).map(toRoomAgentLivenessObservation),
  });
}

export async function upsertRoomAgentPresence(input: {
  room_id: string;
  actor_label: string;
  agent_key?: string | null;
  agent_session_id?: string | null;
  session_kind?: RoomAgentSessionKind;
  runtime?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  status: AgentPresenceStatus;
  status_text?: string | null;
}): Promise<RoomAgentPresence> {
  const now = new Date().toISOString();

  const [presence] = await db
    .insert(room_agent_presence)
    .values({
      room_id: input.room_id,
      actor_label: input.actor_label,
      agent_key: input.agent_key ?? null,
      agent_session_id: input.agent_session_id ?? null,
      session_kind: input.session_kind ?? "controller",
      runtime: input.runtime ?? "unknown",
      display_name: input.display_name,
      owner_label: input.owner_label ?? null,
      ide_label: input.ide_label ?? null,
      status: input.status,
      status_text: input.status_text ?? null,
      last_heartbeat_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [room_agent_presence.room_id, room_agent_presence.actor_label],
      set: {
        agent_key: input.agent_key ?? null,
        agent_session_id: input.agent_session_id ?? null,
        session_kind: input.session_kind ?? "controller",
        runtime: input.runtime ?? "unknown",
        display_name: input.display_name,
        owner_label: input.owner_label ?? null,
        ide_label: input.ide_label ?? null,
        status: input.status,
        status_text: input.status_text ?? null,
        last_heartbeat_at: now,
        updated_at: now,
      },
    })
    .returning();

  return toRoomAgentPresence(presence as RoomAgentPresenceRow);
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
    })
    .returning();

  return toRoomAgentLivenessObservation(observation as RoomAgentLivenessObservationRow);
}

export function buildRoomAgentDeliveryKey(input: {
  actor_label: string;
  agent_session_id?: string | null;
}): string {
  return input.agent_session_id
    ? `agent_session:${input.agent_session_id}`
    : `controller:${input.actor_label}`;
}

export async function markRoomAgentDeliveryConnected(input: {
  room_id: string;
  actor_label: string;
  agent_key?: string | null;
  agent_instance_id?: string | null;
  agent_session_id?: string | null;
  session_kind?: RoomAgentSessionKind;
  runtime?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  transport: RoomAgentDeliveryTransport;
}): Promise<RoomAgentDeliverySession> {
  const now = new Date().toISOString();
  const staleConnectionCutoff = new Date(Date.now() - ACTIVE_AGENT_DELIVERY_WINDOW_MS).toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey(input);

  const [session] = await db
    .insert(room_agent_delivery_sessions)
    .values({
      room_id: input.room_id,
      delivery_key: deliveryKey,
      actor_label: input.actor_label,
      agent_key: input.agent_key ?? null,
      agent_instance_id: input.agent_instance_id ?? null,
      agent_session_id: input.agent_session_id ?? null,
      session_kind: input.session_kind ?? "controller",
      runtime: input.runtime ?? "unknown",
      display_name: input.display_name,
      owner_label: input.owner_label ?? null,
      ide_label: input.ide_label ?? null,
      transport: input.transport,
      active_connection_count: 1,
      last_connected_at: now,
      last_disconnected_at: null,
      reconnect_grace_expires_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [room_agent_delivery_sessions.room_id, room_agent_delivery_sessions.delivery_key],
      set: {
        actor_label: input.actor_label,
        agent_key: input.agent_key ?? null,
        agent_instance_id: input.agent_instance_id ?? null,
        agent_session_id: input.agent_session_id ?? null,
        session_kind: input.session_kind ?? "controller",
        runtime: input.runtime ?? "unknown",
        display_name: input.display_name,
        owner_label: input.owner_label ?? null,
        ide_label: input.ide_label ?? null,
        transport: input.transport,
        active_connection_count: sql`CASE
          WHEN ${room_agent_delivery_sessions.updated_at} < ${staleConnectionCutoff}::timestamptz THEN 1
          ELSE GREATEST(${room_agent_delivery_sessions.active_connection_count}, 0) + 1
        END`,
        last_connected_at: now,
        last_disconnected_at: null,
        reconnect_grace_expires_at: null,
        updated_at: now,
      },
    })
    .returning();

  if ((input.session_kind ?? "controller") === "worker") {
    await setRoomLiveAgentSuppressed({
      room_id: input.room_id,
      actor_labels: [input.actor_label],
      suppressed: false,
    });
  }

  return toRoomAgentDeliverySession(session as RoomAgentDeliverySessionRow);
}

export async function markRoomAgentDeliveryHeartbeat(input: {
  room_id: string;
  actor_label: string;
  agent_session_id?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey(input);
  const [session] = await db
    .update(room_agent_delivery_sessions)
    .set({
      updated_at: now,
    })
    .where(
      and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, deliveryKey),
        sql`${room_agent_delivery_sessions.active_connection_count} > 0`
      )
    )
    .returning({ delivery_key: room_agent_delivery_sessions.delivery_key });

  if (session && input.agent_session_id) {
    await touchRoomAgentSession(input.agent_session_id);
  }
}

export async function markRoomAgentDeliveryDisconnected(input: {
  room_id: string;
  actor_label: string;
  agent_session_id?: string | null;
}): Promise<RoomAgentDeliverySession | null> {
  const now = new Date().toISOString();
  const graceExpiresAt = new Date(Date.now() + ROOM_AGENT_RECONNECT_GRACE_MS).toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey(input);

  const [session] = await db
    .update(room_agent_delivery_sessions)
    .set({
      active_connection_count: sql`GREATEST(${room_agent_delivery_sessions.active_connection_count} - 1, 0)`,
      last_disconnected_at: now,
      reconnect_grace_expires_at: sql`CASE
        WHEN ${room_agent_delivery_sessions.active_connection_count} - 1 > 0 THEN NULL
        ELSE ${graceExpiresAt}::timestamptz
      END`,
      updated_at: now,
    })
    .where(
      and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, deliveryKey)
      )
    )
    .returning();

  if (session && input.agent_session_id) {
    await touchRoomAgentSession(input.agent_session_id);
  }

  return session ? toRoomAgentDeliverySession(session as RoomAgentDeliverySessionRow) : null;
}

export async function forceDisconnectRoomAgentDeliverySession(input: {
  room_id: string;
  agent_session_id: string;
}): Promise<RoomAgentDeliverySession | null> {
  const now = new Date().toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey({
    actor_label: "",
    agent_session_id: input.agent_session_id,
  });

  const [session] = await db
    .update(room_agent_delivery_sessions)
    .set({
      active_connection_count: 0,
      last_disconnected_at: now,
      reconnect_grace_expires_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, deliveryKey)
      )
    )
    .returning();

  return session ? toRoomAgentDeliverySession(session as RoomAgentDeliverySessionRow) : null;
}

export async function getRoomAgentDeliverySessions(
  roomId: string,
  options?: { limit?: number }
): Promise<RoomAgentDeliverySession[]> {
  const limit = clampLimit(options?.limit, 50, 200);
  const rows = await db
    .select()
    .from(room_agent_delivery_sessions)
    .where(eq(room_agent_delivery_sessions.room_id, roomId))
    .orderBy(
      desc(room_agent_delivery_sessions.updated_at),
      desc(room_agent_delivery_sessions.active_connection_count),
      desc(room_agent_delivery_sessions.last_connected_at),
      asc(room_agent_delivery_sessions.display_name)
    )
    .limit(limit);

  return (rows as RoomAgentDeliverySessionRow[]).map(toRoomAgentDeliverySession);
}

export async function getReachableWorkerDeliverySessionForAgentSession(input: {
  room_id: string;
  agent_session_id: string;
}): Promise<RoomAgentDeliverySession | null> {
  const [row] = await db
    .select()
    .from(room_agent_delivery_sessions)
    .where(and(
      eq(room_agent_delivery_sessions.room_id, input.room_id),
      eq(room_agent_delivery_sessions.agent_session_id, input.agent_session_id),
      eq(room_agent_delivery_sessions.session_kind, "worker" as RoomAgentSessionKind)
    ))
    .orderBy(desc(room_agent_delivery_sessions.updated_at))
    .limit(1);

  if (!row) {
    return null;
  }

  const session = toRoomAgentDeliverySession(row as RoomAgentDeliverySessionRow);
  return isRoomAgentDeliverySessionReachable(session) ? session : null;
}

export async function getRoomLiveAgentSuppressionActorLabels(roomId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      actor_label: room_live_agent_suppressions.actor_label,
    })
    .from(room_live_agent_suppressions)
    .where(eq(room_live_agent_suppressions.room_id, roomId));

  return new Set(
    rows
      .map((row) => normalizeRoomActorLabel(row.actor_label))
      .filter(Boolean)
  );
}

export async function setRoomLiveAgentSuppressed(input: {
  room_id: string;
  actor_labels: readonly string[];
  suppressed: boolean;
  suppressed_by?: string | null;
}): Promise<number> {
  const actorLabels = Array.from(
    new Set(input.actor_labels.map((value) => normalizeRoomActorLabel(value)).filter(Boolean))
  );
  if (actorLabels.length === 0) {
    return 0;
  }

  if (!input.suppressed) {
    const result = await db
      .delete(room_live_agent_suppressions)
      .where(
        and(
          eq(room_live_agent_suppressions.room_id, input.room_id),
          inArray(room_live_agent_suppressions.actor_label, actorLabels)
        )
      );

    return Number(result.rowCount ?? 0);
  }

  const now = new Date().toISOString();
  const rows = await db
    .insert(room_live_agent_suppressions)
    .values(actorLabels.map((actorLabel) => ({
      room_id: input.room_id,
      actor_label: actorLabel,
      suppressed_by: input.suppressed_by ?? null,
      created_at: now,
      updated_at: now,
    })))
    .onConflictDoUpdate({
      target: [room_live_agent_suppressions.room_id, room_live_agent_suppressions.actor_label],
      set: {
        suppressed_by: input.suppressed_by ?? null,
        updated_at: now,
      },
    })
    .returning({
      actor_label: room_live_agent_suppressions.actor_label,
    });

  return rows.length;
}

export async function getRoomAgentPresence(
  roomId: string,
  options?: { limit?: number; staleLimit?: number; staleWithinMs?: number }
): Promise<RoomAgentPresence[]> {
  const limit = clampLimit(options?.limit, 50, MAX_LIST_LIMIT);
  const [presence, suppressedActors] = await Promise.all([
    getMergedRoomAgentPresenceRecords(roomId, {
      statusLimit: limit,
      deliveryLimit: limit,
    }),
    getRoomLiveAgentSuppressionActorLabels(roomId),
  ]);

  return filterRoomAgentPresenceForLiveRoster({
    presence,
    suppressedActors,
    limit,
    staleLimit: options?.staleLimit,
    staleWithinMs: options?.staleWithinMs,
  });
}

export async function getRoomAgentPresenceSnapshot(roomId: string): Promise<RoomAgentPresence[]> {
  return getMergedRoomAgentPresenceRecords(roomId);
}
