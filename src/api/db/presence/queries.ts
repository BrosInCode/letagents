import { getAgentAvatars } from "../auth/agent-identities.js";
import { and, asc, desc, eq, getTableColumns, sql, type SQL } from "drizzle-orm";

import { ACTIVE_AGENT_PRESENCE_WINDOW_MS } from "../../../shared/agent-presence.js";
import { db } from "../client.js";
import { toRoomAgentDeliverySession, toRoomAgentLivenessObservation, toRoomAgentPresence } from "../mappers.js";
import {
  room_agent_delivery_sessions,
  room_agent_liveness_observations,
  room_agent_presence,
  room_agent_sessions,
  room_participants,
} from "../schema.js";
import type {
  RoomAgentDeliverySessionRow,
  RoomAgentLivenessObservationRow,
  RoomAgentPresence,
  RoomAgentPresenceRow,
} from "../types.js";
import { clampLimit, MAX_LIST_LIMIT } from "../utils.js";
import { JS_TRIM_CHARACTERS } from "./helpers.js";
import { filterRoomAgentPresenceForLiveRoster, mergeRoomAgentPresenceRecords } from "./merge.js";
import { getRoomLiveAgentSuppressionActorLabels } from "./suppression.js";

/**
 * Which rows a reader can use. A room keeps one controller row for every chat
 * that ever connected, so controller rows outnumber worker rows by far, and no
 * reader shows a controller entry. A controller row can still change a result
 * in two ways, and each scope keeps exactly the rows that can:
 * - "roster": the reader keeps worker entries only. A controller delivery row
 *   matters only when it shares its actor label with a worker status row: the
 *   merge then folds that status row into the controller entry, which hides it.
 * - "history": the reader also decorates each participant with the entry that
 *   has the participant's actor label, whatever its kind. Only delivery rows
 *   are narrowed: nearly every status row of a room belongs to a participant.
 */
export type RoomAgentPresenceRelevance = "roster" | "history";

/**
 * True for a row whose trimmed actor label a history participant can have:
 * stored participants, and the worker entries that become participants.
 * A room without stored participants builds them from message senders, which
 * are not known here, so every row stays relevant there.
 * The route reads the participants in a statement of its own: a participant
 * that joins between the two reads is listed without its decoration for one
 * poll.
 */
function isRelevantToHistory(roomId: string, actorLabel: SQL) {
  return sql`(
    btrim(${actorLabel}, ${JS_TRIM_CHARACTERS}) IN (
      SELECT btrim(participant.actor_label, ${JS_TRIM_CHARACTERS})
        FROM ${room_participants} AS participant
        WHERE participant.room_id = ${roomId} AND participant.actor_label IS NOT NULL
      UNION
      SELECT btrim(worker_delivery.actor_label, ${JS_TRIM_CHARACTERS})
        FROM ${room_agent_delivery_sessions} AS worker_delivery
        WHERE worker_delivery.room_id = ${roomId} AND worker_delivery.session_kind = 'worker'
      UNION
      SELECT btrim(worker_status.actor_label, ${JS_TRIM_CHARACTERS})
        FROM ${room_agent_presence} AS worker_status
        WHERE worker_status.room_id = ${roomId} AND worker_status.session_kind = 'worker'
    )
    OR NOT EXISTS (SELECT 1 FROM ${room_participants} AS participant WHERE participant.room_id = ${roomId})
  )`;
}

/**
 * Retain one latest historical row per worker identity and every currently
 * reachable row. Reachability can expire while SQL runs, so the existing merge
 * still selects the winner at response time. Distinct instances and legacy rows
 * stay separate; first positions preserve identity order on stable sort ties.
 * Rows the history cannot use are left out before the ranking: a worker
 * identity keeps all of its rows, so its order among the kept rows is the same.
 */
function getHistoryDeliverySessions(roomId: string, now: number, relevance?: RoomAgentPresenceRelevance) {
  const nowIso = new Date(now).toISOString();
  const activeSince = new Date(now - ACTIVE_AGENT_PRESENCE_WINDOW_MS).toISOString();
  const relevant = relevance === "history"
    ? sql`AND ${isRelevantToHistory(roomId, sql`${room_agent_delivery_sessions.actor_label}`)}`
    : sql``;
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
          last_connected_at DESC, display_name ASC, delivery_key ASC) AS position
      FROM ${room_agent_delivery_sessions} WHERE room_id = ${roomId} ${relevant}
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

async function readMergedRoomAgentPresenceRecords(
  roomId: string,
  options?: {
    statusLimit?: number;
    deliveryLimit?: number;
    excludeSupervisorManaged?: boolean;
    excludeEndedSessions?: boolean;
    collapseWorkerSessions?: boolean;
    relevantTo?: RoomAgentPresenceRelevance;
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
    // A status row reaches a worker entry on its own, or through the worker
    // delivery row that has its actor label. IN, not = ANY(ARRAY(...)): the
    // worker rows of a room only grow, and PostgreSQL searches an array from
    // its start for every status row, while it hashes this subquery once.
    options?.relevantTo === "roster"
      ? sql`(
        ${room_agent_presence.session_kind} = 'worker'
        OR ${room_agent_presence.actor_label} IN (
          SELECT worker_delivery.actor_label FROM ${room_agent_delivery_sessions} AS worker_delivery
          WHERE worker_delivery.room_id = ${roomId} AND worker_delivery.session_kind = 'worker'
        )
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
    // The roster needs two sets of rows, and each has an index: the worker
    // rows, and the controller rows that share an actor label with a worker
    // status row. Naming them by key keeps the read on those indexes. As
    // "worker OR label matches", PostgreSQL may walk every row of the room and
    // search the labels from their start for each one.
    options?.relevantTo === "roster"
      ? sql`${room_agent_delivery_sessions.delivery_key} IN (
        SELECT worker.delivery_key FROM ${room_agent_delivery_sessions} AS worker
          WHERE worker.room_id = ${roomId} AND worker.session_kind = 'worker'
        UNION ALL
        SELECT controller.delivery_key FROM ${room_agent_presence} AS worker_status
          INNER JOIN ${room_agent_delivery_sessions} AS controller
            ON controller.room_id = worker_status.room_id AND controller.actor_label = worker_status.actor_label
          WHERE worker_status.room_id = ${roomId} AND worker_status.session_kind = 'worker'
            AND controller.session_kind <> 'worker'
      )`
      : undefined,
    options?.relevantTo === "history" && historyNow === undefined
      ? isRelevantToHistory(roomId, sql`${room_agent_delivery_sessions.actor_label}`)
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
    .orderBy(
      desc(room_agent_presence.last_heartbeat_at),
      asc(room_agent_presence.display_name),
      asc(room_agent_presence.actor_label)
    );

  const deliveryQuery = db
    .select()
    .from(room_agent_delivery_sessions)
    .where(deliveryScope)
    .orderBy(
      desc(room_agent_delivery_sessions.updated_at),
      desc(room_agent_delivery_sessions.active_connection_count),
      desc(room_agent_delivery_sessions.last_connected_at),
      asc(room_agent_delivery_sessions.display_name),
      // Rows can tie on every column above (a session end stamps many rows at
      // once). The key makes their order the same for every plan and scope.
      asc(room_agent_delivery_sessions.delivery_key)
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
      ? getHistoryDeliverySessions(roomId, historyNow, options?.relevantTo)
      : options?.deliveryLimit ? deliveryQuery.limit(options.deliveryLimit) : deliveryQuery,
    livenessQuery,
  ]);

  const merged = mergeRoomAgentPresenceRecords({
    roomId,
    statusEntries: (statusRows as RoomAgentPresenceRow[]).map(toRoomAgentPresence),
    deliverySessions: (deliveryRows as RoomAgentDeliverySessionRow[]).map(toRoomAgentDeliverySession),
    livenessObservations: (livenessRows as RoomAgentLivenessObservationRow[]).map(toRoomAgentLivenessObservation),
  });
  return options?.relevantTo === "roster"
    ? merged.filter((entry) => entry.session_kind === "worker")
    : merged;
}

async function withAgentAvatars(entries: RoomAgentPresence[]): Promise<RoomAgentPresence[]> {
  const avatars = await getAgentAvatars(entries.map(entry => entry.agent_key));
  return entries.map(entry => avatars.has(entry.agent_key || "") ? { ...entry, avatar: avatars.get(entry.agent_key!) } : entry);
}

export async function getMergedRoomAgentPresenceRecords(
  roomId: string,
  options?: Parameters<typeof readMergedRoomAgentPresenceRecords>[1]
): Promise<RoomAgentPresence[]> {
  return withAgentAvatars(await readMergedRoomAgentPresenceRecords(roomId, options));
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
    readMergedRoomAgentPresenceRecords(roomId, {
      statusLimit: limit,
      deliveryLimit: limit,
      excludeSupervisorManaged: options?.excludeSupervisorManaged,
      excludeEndedSessions: true,
      relevantTo: "roster",
    }),
    getRoomLiveAgentSuppressionActorLabels(roomId),
  ]);

  // The roster keeps a few of the entries read, so avatars are looked up last.
  return withAgentAvatars(filterRoomAgentPresenceForLiveRoster({
    presence,
    suppressedActors,
    limit,
    staleLimit: options?.staleLimit,
    staleWithinMs: options?.staleWithinMs,
  }));
}

/**
 * Every presence entry of the room, reachable entries first. `relevantTo` narrows the
 * read to the rows one reader can use (see RoomAgentPresenceRelevance); with
 * "roster" the result holds worker entries only. `limit` and `includeAvatars`
 * apply after that, so a reader pays for the entries it returns.
 */
export async function getRoomAgentPresenceSnapshot(
  roomId: string,
  options?: {
    includeEndedSessions?: boolean;
    collapseWorkerSessions?: boolean;
    relevantTo?: RoomAgentPresenceRelevance;
    limit?: number;
    includeAvatars?: boolean;
  },
): Promise<RoomAgentPresence[]> {
  const merged = await readMergedRoomAgentPresenceRecords(roomId, {
    excludeEndedSessions: !options?.includeEndedSessions,
    collapseWorkerSessions: options?.includeEndedSessions && options?.collapseWorkerSessions,
    relevantTo: options?.relevantTo,
  });
  const entries = options?.limit === undefined ? merged : merged.slice(0, Math.max(0, options.limit));
  return options?.includeAvatars === false ? entries : withAgentAvatars(entries);
}
