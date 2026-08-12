import { sql } from "drizzle-orm";

import { db } from "../client.js";
import { normalizeRoomActorLabel } from "../presence/helpers.js";

const MAX_DUE_CONTEXT_ROOMS = 500;

function boundedRoomIds(roomIds: readonly string[]): string[] {
  const values = [...new Set(roomIds.filter(Boolean))];
  if (values.length > MAX_DUE_CONTEXT_ROOMS) {
    throw new RangeError(`due-room context exceeds ${MAX_DUE_CONTEXT_ROOMS} rooms`);
  }
  return values;
}

export interface LivenessRoomContext {
  suppressed_actor_labels: ReadonlySet<string>;
  active_manager_session_id: string | null;
}

/** Two set-based reads replace suppression + manager N+1s for one due page. */
export async function getLivenessRoomContexts(
  roomIds: readonly string[],
): Promise<Map<string, LivenessRoomContext>> {
  const ids = boundedRoomIds(roomIds);
  const result = new Map<string, LivenessRoomContext>(ids.map((roomId) => [roomId, {
    suppressed_actor_labels: new Set<string>(),
    active_manager_session_id: null,
  }]));
  if (ids.length === 0) return result;
  const [suppressions, managers] = await Promise.all([
    db.execute<{ room_id: string; actor_label: string }>(sql`
      SELECT room_id, actor_label FROM room_live_agent_suppressions
       WHERE room_id IN (
         SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)
       )
    `),
    db.execute<{ room_id: string; agent_session_id: string }>(sql`
      SELECT assignment.room_id, assignment.agent_session_id
        FROM board_manager_assignments AS assignment
        JOIN room_agent_sessions AS session
          ON session.room_id = assignment.room_id
         AND session.session_id = assignment.agent_session_id
         AND session.session_kind = 'worker'
         AND session.ended_at IS NULL
       WHERE assignment.status = 'active'
         AND assignment.room_id IN (
           SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)
         )
    `),
  ]);
  for (const row of suppressions.rows) {
    const label = normalizeRoomActorLabel(row.actor_label);
    if (label) (result.get(row.room_id)!.suppressed_actor_labels as Set<string>).add(label);
  }
  for (const row of managers.rows) result.get(row.room_id)!.active_manager_session_id = row.agent_session_id;
  return result;
}

export interface DueRoomOperationalContext {
  reachable_manager_room_ids: ReadonlySet<string>;
  live_worker_labels_by_room: ReadonlyMap<string, readonly string[]>;
}

/**
 * One bounded query supplies delivery + manager state for intent and drained
 * board pages. It uses delivery authority (not mutable labels) and excludes
 * supervisor-owned workers and room suppressions before applying 20/room.
 */
export async function getDueRoomOperationalContext(
  roomIds: readonly string[],
  now = Date.now(),
): Promise<DueRoomOperationalContext> {
  const ids = boundedRoomIds(roomIds);
  if (ids.length === 0) {
    return { reachable_manager_room_ids: new Set(), live_worker_labels_by_room: new Map() };
  }
  const result = await db.execute<{
    room_id: string;
    actor_label: string | null;
    agent_session_id: string | null;
    manager: boolean;
  }>(sql`
          WITH selected_room AS (
            SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS room_id
          ), reachable AS (
            SELECT delivery.room_id, delivery.actor_label, delivery.agent_session_id
              FROM room_agent_delivery_sessions AS delivery
              JOIN selected_room ON selected_room.room_id = delivery.room_id
              LEFT JOIN room_agent_sessions AS session
                ON session.room_id = delivery.room_id
               AND session.session_id = delivery.agent_session_id
             WHERE delivery.session_kind = 'worker'
               AND (session.ended_at IS NULL OR session.session_id IS NULL)
               AND (
                 (delivery.active_connection_count > 0
                   AND delivery.updated_at >= ${new Date(now).toISOString()}::timestamptz - interval '90 seconds')
                 OR delivery.reconnect_grace_expires_at >= ${new Date(now).toISOString()}::timestamptz
               )
          ), manager_room AS (
            SELECT DISTINCT reachable.room_id
              FROM reachable
              JOIN board_manager_assignments AS assignment
                ON assignment.room_id = reachable.room_id
               AND assignment.agent_session_id = reachable.agent_session_id
               AND assignment.status = 'active'
          ), reminder_eligible AS (
            SELECT reachable.*
              FROM reachable
              LEFT JOIN room_agent_sessions AS session
                ON session.room_id = reachable.room_id
               AND session.session_id = reachable.agent_session_id
             WHERE session.supervisor_grant_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM room_live_agent_suppressions AS suppression
                  WHERE suppression.room_id = reachable.room_id
                    AND suppression.actor_label = trim(reachable.actor_label)
               )
          ), ranked AS (
            SELECT reminder_eligible.*,
                   row_number() OVER (PARTITION BY room_id ORDER BY actor_label, agent_session_id) AS rank
              FROM reminder_eligible
          )
          SELECT selected_room.room_id,
                 ranked.actor_label,
                 ranked.agent_session_id,
                 manager_room.room_id IS NOT NULL AS manager
            FROM selected_room
            LEFT JOIN ranked
              ON ranked.room_id = selected_room.room_id
             AND ranked.rank <= 20
            LEFT JOIN manager_room ON manager_room.room_id = selected_room.room_id
  `);
  const managers = new Set<string>();
  const labels = new Map<string, string[]>();
  for (const row of result.rows) {
    if (row.actor_label) {
      const entries = labels.get(row.room_id) ?? [];
      entries.push(row.actor_label);
      labels.set(row.room_id, entries);
    }
    if (row.manager) managers.add(row.room_id);
  }
  return { reachable_manager_room_ids: managers, live_worker_labels_by_room: labels };
}
