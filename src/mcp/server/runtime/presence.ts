import { getRoomIdentityPresenceCacheKey } from "../../agent-presence.js";
import { encodeRoomIdPath } from "../../room-id.js";
import { touchRoomSession, type StoredAgentIdentityState, type StoredAgentSessionState } from "../../local-state.js";
import { type AgentPresenceStatus } from "../../../shared/agent-presence.js";
import { apiCall, isMissingRouteError } from "./api.js";
import { agentSessionCredentials, identityFromAgentSession } from "./agent-sessions.js";
import { getSessionLivenessRegistration } from "./identity.js";

const roomPresenceByIdentity = new Map<
  string,
  { status: AgentPresenceStatus; status_text: string | null }
>();

export function getRememberedRoomPresence(
  roomId: string | null | undefined,
  identity: StoredAgentIdentityState | null | undefined
): { status: AgentPresenceStatus; status_text: string | null } {
  if (!roomId || !identity) {
    return { status: "idle", status_text: null };
  }

  return (
    roomPresenceByIdentity.get(
      getRoomIdentityPresenceCacheKey(roomId, identity.actor_label)
    ) ?? { status: "idle", status_text: null }
  );
}

export async function syncRoomPresence(
  roomId: string | null | undefined,
  identity: StoredAgentIdentityState | null | undefined,
  presence: { status: AgentPresenceStatus; status_text: string | null },
  agentSession?: StoredAgentSessionState | null
): Promise<void> {
  const resolvedIdentity = agentSession ? identityFromAgentSession(agentSession) : identity;
  if (!roomId || !resolvedIdentity || !agentSession) {
    return;
  }

  roomPresenceByIdentity.set(
    getRoomIdentityPresenceCacheKey(roomId, resolvedIdentity.actor_label),
    presence
  );

  try {
    await apiCall(`/rooms/${encodeRoomIdPath(roomId)}/presence`, {
      method: "POST",
      body: JSON.stringify({
        actor_label: resolvedIdentity.actor_label,
        agent_key: resolvedIdentity.canonical_key,
        display_name: resolvedIdentity.display_name,
        owner_label: resolvedIdentity.owner_label,
        ide_label: resolvedIdentity.ide_label,
        status: presence.status,
        status_text: presence.status_text,
        liveness_observation: getSessionLivenessRegistration(),
        ...agentSessionCredentials(agentSession),
      }),
    });
    touchRoomSession(roomId);
  } catch (error) {
    if (isMissingRouteError(error)) {
      return;
    }
    throw error;
  }
}

export async function heartbeatRoomPresence(
  roomId: string | null | undefined,
  identity: StoredAgentIdentityState | null | undefined
): Promise<void> {
  await syncRoomPresence(roomId, identity, getRememberedRoomPresence(roomId, identity));
}
