import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  ACTIVE_AGENT_DELIVERY_WINDOW_MS,
  ROOM_AGENT_RECONNECT_GRACE_MS,
  type RoomAgentDeliveryTransport,
  type RoomAgentSessionKind,
} from "../../../shared/agent-presence.js";
import { touchRoomAgentSession } from "../auth.js";
import { db } from "../client.js";
import { toRoomAgentDeliverySession } from "../mappers.js";
import { room_agent_delivery_sessions } from "../schema.js";
import { clampLimit } from "../utils.js";
import type { RoomAgentDeliverySession, RoomAgentDeliverySessionRow } from "../types.js";
import {
  buildRoomAgentDeliveryKey,
  isRoomAgentDeliverySessionReachable,
} from "./helpers.js";
import { setRoomLiveAgentSuppressed } from "./suppression.js";

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
  repo_branch?: string | null;
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
      repo_branch: input.repo_branch ?? null,
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
        repo_branch: input.repo_branch ?? null,
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
