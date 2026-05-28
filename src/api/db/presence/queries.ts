import { asc, desc, eq } from "drizzle-orm";

import { db } from "../client.js";
import { toRoomAgentDeliverySession, toRoomAgentLivenessObservation, toRoomAgentPresence } from "../mappers.js";
import { room_agent_delivery_sessions, room_agent_liveness_observations, room_agent_presence } from "../schema.js";
import type {
  RoomAgentDeliverySessionRow,
  RoomAgentLivenessObservationRow,
  RoomAgentPresence,
  RoomAgentPresenceRow,
} from "../types.js";
import { clampLimit, MAX_LIST_LIMIT } from "../utils.js";
import { filterRoomAgentPresenceForLiveRoster, mergeRoomAgentPresenceRecords } from "./merge.js";
import { getRoomLiveAgentSuppressionActorLabels } from "./suppression.js";

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
