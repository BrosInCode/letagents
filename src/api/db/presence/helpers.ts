import {
  isAgentDeliverySessionReachable,
} from "../../../shared/agent-presence.js";
import type { RoomAgentDeliverySession } from "../types.js";

export function normalizeRoomActorLabel(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/**
 * Every character that String.prototype.trim removes. The history matches
 * presence to participants by trimmed actor label, and SQL btrim removes only
 * spaces unless it is given the same set.
 */
export const JS_TRIM_CHARACTERS =
  "\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

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

export function buildRoomAgentDeliveryKey(input: {
  actor_label: string;
  agent_session_id?: string | null;
}): string {
  return input.agent_session_id
    ? `agent_session:${input.agent_session_id}`
    : `controller:${input.actor_label}`;
}
