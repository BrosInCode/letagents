import { buildAgentRoomParticipantKey } from "../shared/room-participant.js";
import type { RoomAgentDeliveryTransport } from "../shared/agent-presence.js";
import { ROOM_AGENT_DELIVERY_HEARTBEAT_INTERVAL_MS } from "../shared/agent-presence.js";
import {
  markRoomAgentDeliveryConnected,
  markRoomAgentDeliveryDisconnected,
  markRoomAgentDeliveryHeartbeat,
  upsertRoomParticipant,
} from "./db.js";
import type { AuthenticatedRequest } from "./http-helpers.js";
import { resolveRequestAgentIdentity } from "./request-agent-identity.js";

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

export async function beginRoomAgentDelivery(input: {
  req: AuthenticatedRequest;
  roomId: string;
  transport: RoomAgentDeliveryTransport;
}): Promise<(() => Promise<void>) | null> {
  const identity = await resolveRequestAgentIdentity({
    req: input.req,
    actor_label: getOptionalQueryString(input.req.query.actor_label),
    actor_key: getOptionalQueryString(input.req.query.actor_key),
    actor_instance_id: getOptionalQueryString(input.req.query.actor_instance_id),
  });
  if (!identity) {
    return null;
  }

  await markRoomAgentDeliveryConnected({
    room_id: input.roomId,
    actor_label: identity.actor_label,
    agent_key: identity.agent_key,
    agent_instance_id: identity.agent_instance_id,
    display_name: identity.display_name,
    owner_label: identity.owner_label,
    ide_label: identity.ide_label,
    transport: input.transport,
  });

  const participantKey = buildAgentRoomParticipantKey(identity.actor_label);
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
    }).catch((error: unknown) => {
      console.error(`[room agent delivery] failed to refresh delivery heartbeat for ${input.roomId}`, error);
    });
  }, ROOM_AGENT_DELIVERY_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  let ended = false;
  return async () => {
    if (ended) {
      return;
    }

    ended = true;
    clearInterval(heartbeat);
    await markRoomAgentDeliveryDisconnected({
      room_id: input.roomId,
      actor_label: identity.actor_label,
    });
  };
}
