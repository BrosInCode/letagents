import { and, eq, sql } from "drizzle-orm";

import { getAgentPresenceFreshness, isAgentDeliverySessionReachable } from "../../../shared/agent-presence.js";
import { room_agent_delivery_sessions } from "../schema.js";
import type { db } from "../client.js";

type Executor = Pick<typeof db, "select">;

/**
 * Which of these sessions can be reached, and which hold a connection open
 * right now. Reachable includes a session inside its reconnect grace;
 * connected does not.
 */
export async function getSessionConnections(
  executor: Executor,
  roomId: string,
  sessionIds: readonly string[],
  nowMs = Date.now(),
): Promise<{ reachable: Set<string>; connected: Set<string> }> {
  const reachable = new Set<string>();
  const connected = new Set<string>();
  if (sessionIds.length === 0) return { reachable, connected };
  const deliveryKeys = sessionIds.map((sessionId) => `agent_session:${sessionId}`);
  const deliverySessions = await executor
    .select({
      agent_session_id: room_agent_delivery_sessions.agent_session_id,
      active_connection_count: room_agent_delivery_sessions.active_connection_count,
      updated_at: room_agent_delivery_sessions.updated_at,
      reconnect_grace_expires_at: room_agent_delivery_sessions.reconnect_grace_expires_at,
    })
    .from(room_agent_delivery_sessions)
    .where(and(
      eq(room_agent_delivery_sessions.room_id, roomId),
      // Probe the existing (room_id, delivery_key) primary key instead of
      // scanning the unindexed agent_session_id column. Historical
      // delivery summaries accumulate in long-lived rooms.
      sql`${room_agent_delivery_sessions.delivery_key} IN (
        SELECT value
          FROM jsonb_array_elements_text(${JSON.stringify(deliveryKeys)}::jsonb)
      )`,
    ));
  for (const delivery of deliverySessions) {
    if (!delivery.agent_session_id) continue;
    if (isAgentDeliverySessionReachable({
      activeConnectionCount: delivery.active_connection_count,
      updatedAt: delivery.updated_at,
      reconnectGraceExpiresAt: delivery.reconnect_grace_expires_at,
    }, nowMs)) reachable.add(delivery.agent_session_id);
    if (delivery.active_connection_count > 0
      && getAgentPresenceFreshness(delivery.updated_at ?? "", nowMs) === "active") {
      connected.add(delivery.agent_session_id);
    }
  }
  return { reachable, connected };
}
