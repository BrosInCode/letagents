import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm";

import { ACTIVE_AGENT_PRESENCE_WINDOW_MS } from "../../../shared/agent-presence.js";
import { db } from "../client.js";
import { toRoomAgentDeliverySession, toRoomAgentLivenessObservation, toRoomAgentPresence } from "../mappers.js";
import { room_agent_delivery_sessions, room_agent_liveness_observations, room_agent_presence, room_agent_sessions } from "../schema.js";
import type {
  RoomAgentDeliverySessionRow,
  RoomAgentLivenessObservationRow,
  RoomAgentPresence,
  RoomAgentPresenceRow,
} from "../types.js";
import { clampLimit, MAX_LIST_LIMIT } from "../utils.js";
import { filterRoomAgentPresenceForLiveRoster, mergeRoomAgentPresenceRecords } from "./merge.js";
import { getRoomLiveAgentSuppressionActorLabels } from "./suppression.js";

/**
 * Retain one latest historical row per worker identity and every currently
 * reachable row. Reachability can expire while SQL runs, so the existing merge
 * still selects the winner at response time. Distinct instances and legacy rows
 * stay separate; first positions preserve identity order on stable sort ties.
 */
function getHistoryDeliverySessions(roomId: string, now: number) {
  const nowIso = new Date(now).toISOString();
  const activeSince = new Date(now - ACTIVE_AGENT_PRESENCE_WINDOW_MS).toISOString();
  const winners = sql`(
    WITH ordered AS (
      SELECT delivery_key, agent_key, agent_instance_id,
        session_kind = 'worker' AND COALESCE(agent_key, '') <> ''
          AND COALESCE(agent_instance_id, '') <> '' AS collapsible,
        COALESCE((active_connection_count > 0
          AND date_trunc('milliseconds', updated_at) >= ${activeSince}::timestamptz)
          OR date_trunc('milliseconds', reconnect_grace_expires_at) >= ${nowIso}::timestamptz, FALSE) AS reachable,
        date_trunc('milliseconds', COALESCE(last_disconnected_at, updated_at, last_connected_at)) AS last_seen,
        ROW_NUMBER() OVER (ORDER BY updated_at DESC, active_connection_count DESC,
          last_connected_at DESC, display_name ASC) AS position
      FROM ${room_agent_delivery_sessions} WHERE room_id = ${roomId}
    ), ranked AS (
      SELECT delivery_key, position, reachable,
        MIN(position) OVER identity AS first_position,
        ROW_NUMBER() OVER (identity ORDER BY last_seen DESC, position ASC) AS preference
      FROM ordered
      WINDOW identity AS (PARTITION BY
        CASE WHEN collapsible THEN agent_key END,
        CASE WHEN collapsible THEN agent_instance_id END,
        CASE WHEN NOT collapsible THEN delivery_key END)
    )
    SELECT delivery_key, first_position, position FROM ranked WHERE preference = 1 OR reachable
  ) AS history_delivery`;
  return db.select(getTableColumns(room_agent_delivery_sessions))
    .from(room_agent_delivery_sessions)
    .innerJoin(winners, eq(room_agent_delivery_sessions.delivery_key, sql`history_delivery.delivery_key`))
    .where(eq(room_agent_delivery_sessions.room_id, roomId))
    .orderBy(sql`history_delivery.first_position`, sql`history_delivery.position`);
}

export async function getMergedRoomAgentPresenceRecords(
  roomId: string,
  options?: {
    statusLimit?: number;
    deliveryLimit?: number;
    excludeSupervisorManaged?: boolean;
    excludeEndedSessions?: boolean;
    collapseWorkerSessions?: boolean;
  }
): Promise<RoomAgentPresence[]> {
  const historyNow = options?.collapseWorkerSessions ? Date.now() : undefined;
  const statusScope = and(
    eq(room_agent_presence.room_id, roomId),
    options?.excludeEndedSessions
      ? sql`(
        ${room_agent_presence.agent_session_id} IS NULL
        OR EXISTS (
          SELECT 1 FROM ${room_agent_sessions}
          WHERE ${room_agent_sessions.room_id} = ${room_agent_presence.room_id}
            AND ${room_agent_sessions.session_id} = ${room_agent_presence.agent_session_id}
            AND ${room_agent_sessions.ended_at} IS NULL
        )
      )`
      : undefined,
    options?.excludeSupervisorManaged
      ? sql`NOT EXISTS (
        SELECT 1 FROM ${room_agent_sessions}
        WHERE ${room_agent_sessions.room_id} = ${room_agent_presence.room_id}
          AND ${room_agent_sessions.session_id} = ${room_agent_presence.agent_session_id}
          AND ${room_agent_sessions.session_kind} = 'worker'
          AND ${room_agent_sessions.supervisor_grant_id} IS NOT NULL
      )`
      : undefined,
  );
  const deliveryScope = and(
    eq(room_agent_delivery_sessions.room_id, roomId),
    options?.excludeEndedSessions
      ? sql`(
        ${room_agent_delivery_sessions.agent_session_id} IS NULL
        OR EXISTS (
          SELECT 1 FROM ${room_agent_sessions}
          WHERE ${room_agent_sessions.room_id} = ${room_agent_delivery_sessions.room_id}
            AND ${room_agent_sessions.session_id} = ${room_agent_delivery_sessions.agent_session_id}
            AND ${room_agent_sessions.ended_at} IS NULL
        )
      )`
      : undefined,
    options?.excludeSupervisorManaged
      ? sql`NOT EXISTS (
        SELECT 1 FROM ${room_agent_sessions}
        WHERE ${room_agent_sessions.room_id} = ${room_agent_delivery_sessions.room_id}
          AND ${room_agent_sessions.session_id} = ${room_agent_delivery_sessions.agent_session_id}
          AND ${room_agent_sessions.session_kind} = 'worker'
          AND ${room_agent_sessions.supervisor_grant_id} IS NOT NULL
      )`
      : undefined,
  );
  const livenessScope = and(
    eq(room_agent_liveness_observations.room_id, roomId),
    options?.excludeEndedSessions
      ? sql`EXISTS (
        SELECT 1 FROM ${room_agent_sessions}
        WHERE ${room_agent_sessions.room_id} = ${room_agent_liveness_observations.room_id}
          AND ${room_agent_sessions.session_id} = ${room_agent_liveness_observations.agent_session_id}
          AND ${room_agent_sessions.ended_at} IS NULL
      )`
      : undefined,
  );
  const statusQuery = db
    .select()
    .from(room_agent_presence)
    .where(statusScope)
    .orderBy(desc(room_agent_presence.last_heartbeat_at), asc(room_agent_presence.display_name));

  const deliveryQuery = db
    .select()
    .from(room_agent_delivery_sessions)
    .where(deliveryScope)
    .orderBy(
      desc(room_agent_delivery_sessions.updated_at),
      desc(room_agent_delivery_sessions.active_connection_count),
      desc(room_agent_delivery_sessions.last_connected_at),
      asc(room_agent_delivery_sessions.display_name)
    );

  const livenessQuery = db
    .select()
    .from(room_agent_liveness_observations)
    .where(livenessScope)
    .orderBy(desc(room_agent_liveness_observations.last_observed_at))
    .limit(Math.max(options?.deliveryLimit ?? options?.statusLimit ?? 50, 200));

  const [statusRows, deliveryRows, livenessRows] = await Promise.all([
    options?.statusLimit ? statusQuery.limit(options.statusLimit) : statusQuery,
    historyNow !== undefined
      ? getHistoryDeliverySessions(roomId, historyNow)
      : options?.deliveryLimit ? deliveryQuery.limit(options.deliveryLimit) : deliveryQuery,
    livenessQuery,
  ]);

  return mergeRoomAgentPresenceRecords({
    roomId,
    statusEntries: (statusRows as RoomAgentPresenceRow[]).map(toRoomAgentPresence),
    deliverySessions: (deliveryRows as RoomAgentDeliverySessionRow[]).map(toRoomAgentDeliverySession),
    livenessObservations: (livenessRows as RoomAgentLivenessObservationRow[]).map(toRoomAgentLivenessObservation),
  });
}

export async function getRoomAgentPresence(
  roomId: string,
  options?: {
    limit?: number;
    staleLimit?: number;
    staleWithinMs?: number;
    excludeSupervisorManaged?: boolean;
  }
): Promise<RoomAgentPresence[]> {
  const limit = clampLimit(options?.limit, 50, MAX_LIST_LIMIT);
  const [presence, suppressedActors] = await Promise.all([
    getMergedRoomAgentPresenceRecords(roomId, {
      statusLimit: limit,
      deliveryLimit: limit,
      excludeSupervisorManaged: options?.excludeSupervisorManaged,
      excludeEndedSessions: true,
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

export async function getRoomAgentPresenceSnapshot(
  roomId: string,
  options?: { includeEndedSessions?: boolean; collapseWorkerSessions?: boolean },
): Promise<RoomAgentPresence[]> {
  return getMergedRoomAgentPresenceRecords(roomId, {
    excludeEndedSessions: !options?.includeEndedSessions,
    collapseWorkerSessions: options?.includeEndedSessions && options?.collapseWorkerSessions,
  });
}
