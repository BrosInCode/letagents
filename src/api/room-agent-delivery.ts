import { EventEmitter } from "node:events";

import { buildAgentRoomParticipantKey } from "../shared/room-participant.js";
import type { RoomAgentDeliveryTransport } from "../shared/agent-presence.js";
import { ROOM_AGENT_DELIVERY_HEARTBEAT_INTERVAL_MS } from "../shared/agent-presence.js";
import {
  forceDisconnectRoomAgentDeliverySession,
  markRoomAgentDeliveryConnected,
  markRoomAgentDeliveryDisconnected,
  markRoomAgentDeliveryHeartbeat,
  upsertRoomParticipant,
} from "./db.js";
import type { AuthenticatedRequest } from "./http-helpers.js";
import { resolveRequestAgentIdentity } from "./request-agent-identity.js";
import {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../shared/request-headers.js";

const roomAgentDeliveryEvents = new EventEmitter();

export class InvalidRoomAgentDeliverySessionError extends Error {
  constructor() {
    super("Invalid agent session credentials.");
    this.name = "InvalidRoomAgentDeliverySessionError";
  }
}

function getOptionalQueryString(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }

  if (Array.isArray(value)) {
    return getOptionalQueryString(value[0]);
  }

  return null;
}

function getOptionalHeaderString(req: AuthenticatedRequest, headerName: string): string | null {
  const normalized = String(req.get(headerName) ?? "").trim();
  return normalized || null;
}

function roomAgentSessionDisconnectedEventName(roomId: string, agentSessionId: string): string {
  return `${roomId}\n${agentSessionId}`;
}

export async function disconnectRoomAgentDeliverySession(input: {
  room_id: string;
  agent_session_id: string;
}): Promise<Awaited<ReturnType<typeof forceDisconnectRoomAgentDeliverySession>>> {
  const deliverySession = await forceDisconnectRoomAgentDeliverySession(input);
  roomAgentDeliveryEvents.emit(
    roomAgentSessionDisconnectedEventName(input.room_id, input.agent_session_id)
  );
  return deliverySession;
}

export async function beginRoomAgentDelivery(input: {
  req: AuthenticatedRequest;
  roomId: string;
  transport: RoomAgentDeliveryTransport;
  onSessionDisconnected?: () => void;
}): Promise<(() => Promise<void>) | null> {
  const agentSessionId = getOptionalHeaderString(input.req, LETAGENTS_AGENT_SESSION_ID_HEADER);
  const agentSessionToken = getOptionalHeaderString(input.req, LETAGENTS_AGENT_SESSION_TOKEN_HEADER);
  const hasAgentSessionCredentials = Boolean(agentSessionId || agentSessionToken);
  if (hasAgentSessionCredentials && (!agentSessionId || !agentSessionToken)) {
    throw new InvalidRoomAgentDeliverySessionError();
  }
  const identity = await resolveRequestAgentIdentity({
    req: input.req,
    actor_label: getOptionalQueryString(input.req.query.actor_label),
    actor_key: getOptionalQueryString(input.req.query.actor_key),
    actor_instance_id: getOptionalQueryString(input.req.query.actor_instance_id),
    agent_session_id: agentSessionId,
    agent_session_token: agentSessionToken,
    room_id: input.roomId,
  });
  if (!identity) {
    if (hasAgentSessionCredentials) {
      throw new InvalidRoomAgentDeliverySessionError();
    }
    return null;
  }
  if (hasAgentSessionCredentials && !identity.agent_session_id) {
    throw new InvalidRoomAgentDeliverySessionError();
  }

  await markRoomAgentDeliveryConnected({
    room_id: input.roomId,
    actor_label: identity.actor_label,
    agent_key: identity.agent_key,
    agent_instance_id: identity.agent_instance_id,
    agent_session_id: identity.agent_session_id,
    session_kind: identity.session_kind,
    runtime: identity.runtime,
    display_name: identity.display_name,
    owner_label: identity.owner_label,
    ide_label: identity.ide_label,
    transport: input.transport,
  });

  const participantKey = identity.session_kind === "worker"
    ? buildAgentRoomParticipantKey(identity.actor_label)
    : null;
  if (participantKey) {
    await upsertRoomParticipant({
      room_id: input.roomId,
      participant_key: participantKey,
      kind: "agent",
      actor_label: identity.actor_label,
      agent_key: identity.agent_key,
      display_name: identity.display_name,
      owner_label: identity.owner_label,
      ide_label: identity.ide_label,
      last_seen_at: new Date().toISOString(),
      preserve_last_seen_at_on_conflict: true,
    });
  }

  const heartbeat = setInterval(() => {
    void markRoomAgentDeliveryHeartbeat({
      room_id: input.roomId,
      actor_label: identity.actor_label,
      agent_session_id: identity.agent_session_id,
    }).catch((error: unknown) => {
      console.error(`[room agent delivery] failed to refresh delivery heartbeat for ${input.roomId}`, error);
    });
  }, ROOM_AGENT_DELIVERY_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const sessionDisconnectedEvent =
    identity.agent_session_id && input.onSessionDisconnected
      ? roomAgentSessionDisconnectedEventName(input.roomId, identity.agent_session_id)
      : null;
  const onSessionDisconnected = sessionDisconnectedEvent
    ? function handleSessionDisconnected() {
        roomAgentDeliveryEvents.off(sessionDisconnectedEvent, handleSessionDisconnected);
        input.onSessionDisconnected?.();
      }
    : null;
  if (sessionDisconnectedEvent && onSessionDisconnected) {
    roomAgentDeliveryEvents.on(sessionDisconnectedEvent, onSessionDisconnected);
  }

  let ended = false;
  return async () => {
    if (ended) {
      return;
    }

    ended = true;
    clearInterval(heartbeat);
    if (sessionDisconnectedEvent && onSessionDisconnected) {
      roomAgentDeliveryEvents.off(sessionDisconnectedEvent, onSessionDisconnected);
    }
    await markRoomAgentDeliveryDisconnected({
      room_id: input.roomId,
      actor_label: identity.actor_label,
      agent_session_id: identity.agent_session_id,
    });
  };
}
