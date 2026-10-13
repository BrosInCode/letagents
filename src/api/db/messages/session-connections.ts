import { and, eq, sql } from "drizzle-orm";

import { ACTIVE_AGENT_DELIVERY_WINDOW_MS, getAgentPresenceFreshness, isAgentDeliverySessionReachable } from "../../../shared/agent-presence.js";
import { room_agent_delivery_instances, room_agent_delivery_sessions, room_agent_session_bearers, room_agent_sessions } from "../schema.js";
import type { db } from "../client.js";
import { bearerDeliveryCredentialFingerprint, sessionTokenDeliveryCredentialFingerprint } from "../../rooms/agent-credential-events.js";

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

/** A blocking turn needs a current worker poll/SSE lease, not just an open desktop window. */
export async function getReplyTurnReadySessions(
  executor: Executor, roomId: string, sessionIds: readonly string[], nowMs = Date.now(),
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const delivery = room_agent_delivery_sessions;
  const instance = room_agent_delivery_instances;
  const session = room_agent_sessions;
  const bearer = room_agent_session_bearers;
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - ACTIVE_AGENT_DELIVERY_WINDOW_MS).toISOString();
  const deliveryKeys = JSON.stringify(sessionIds.map(id => `agent_session:${id}`));
  const rows = await executor.select({
    session_id: session.session_id, token_hash: session.token_hash,
    fingerprint: instance.credential_fingerprint,
    bearer_id: bearer.bearer_id, generation: bearer.generation,
  }).from(delivery)
    .innerJoin(session, and(eq(session.room_id, delivery.room_id), eq(session.session_id, delivery.agent_session_id)))
    .innerJoin(instance, and(
      eq(instance.room_id, delivery.room_id), eq(instance.delivery_key, delivery.delivery_key),
      sql`${instance.transport} IN ('long_poll', 'sse')`, sql`${instance.updated_at} >= ${cutoff}::timestamptz`,
    ))
    .leftJoin(bearer, and(
      eq(bearer.session_id, session.session_id),
      sql`${bearer.revoked_at} IS NULL`, sql`${bearer.expires_at} > ${now}::timestamptz`,
    ))
    .where(and(
      eq(delivery.room_id, roomId),
      sql`${delivery.delivery_key} IN (SELECT value FROM jsonb_array_elements_text(${deliveryKeys}::jsonb))`,
      eq(session.session_kind, "worker"), sql`${session.ended_at} IS NULL`,
      sql`${delivery.active_connection_count} > 0`, sql`${delivery.updated_at} >= ${cutoff}::timestamptz`,
    ));
  // Desktop heartbeats and worker polls may use different current credentials.
  // Validate the actual connection, not whichever credential last wrote the summary.
  return new Set(rows.filter(row => row.fingerprint === sessionTokenDeliveryCredentialFingerprint(row.token_hash)
    || (row.bearer_id !== null && row.generation !== null
      && row.fingerprint === bearerDeliveryCredentialFingerprint(row.bearer_id, row.generation)))
    .map(row => row.session_id));
}
