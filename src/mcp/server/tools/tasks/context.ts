import {
  AGENT_INSTANCE_UUID,
  agentSessionCredentials,
  currentRoom,
  getFallbackProjectId,
  getTargetRoomId,
  resolveWorkerToolIdentity,
  type StoredAgentIdentityState,
  type StoredAgentSessionState,
} from "../../runtime.js";

export type TaskToolTarget = {
  roomId: string | null;
  projectId: string | null;
  effectiveRoomId: string | null;
};

export function resolveTaskToolTarget(roomId?: string): TaskToolTarget | null {
  const targetRoomId = getTargetRoomId(roomId);
  const targetProjectId = getFallbackProjectId();
  if (!targetRoomId && !targetProjectId) return null;

  return {
    roomId: targetRoomId ?? null,
    projectId: targetProjectId ?? null,
    effectiveRoomId: targetRoomId ?? currentRoom?.room_id ?? null,
  };
}

export function resolveCanonicalRoomId(roomId?: string): string | null {
  return getTargetRoomId(roomId) ?? null;
}

export function resolveTaskToolIdentity(target: TaskToolTarget, agentSessionId?: string) {
  return resolveWorkerToolIdentity({
    roomId: target.effectiveRoomId,
    agentSessionId,
  });
}

export function resolveCanonicalTaskToolIdentity(roomId: string, agentSessionId?: string) {
  return resolveWorkerToolIdentity({
    roomId,
    agentSessionId,
  });
}

export function taskActorPayload(
  identity: StoredAgentIdentityState,
  agentSession: StoredAgentSessionState
) {
  return {
    actor_label: identity.actor_label,
    actor_key: identity.canonical_key,
    actor_instance_id: agentSession.agent_instance_id || AGENT_INSTANCE_UUID,
    ...agentSessionCredentials(agentSession),
  };
}
