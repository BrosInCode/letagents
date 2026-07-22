import type {
  DesktopRoomAgentConnectionState,
  DesktopRoomAgentIngressState,
  DesktopRoomAgentInboxState,
  DesktopRoomAgentTurnState,
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";

export type RoomAgentDeliveryGroup = "listening" | "responding" | "attention" | "disconnected";

type RoomAgentActivityEntry = Pick<
  DesktopSupervisorManifestEntry,
  "agentSessionId" | "desiredState" | "observedState" | "roomAgentState" | "roomId"
>;

/**
 * A stopped supervisor record is history, but its session identity must still
 * suppress any stale server-presence echo from the Live roster.
 */
export function roomAgentActivityProjection<T extends RoomAgentActivityEntry>(
  entries: readonly T[],
  roomId: string | null,
): { liveAgents: T[]; projectedSessionIds: Set<string> } {
  const scoped = entries.filter((entry) => entry.roomId === roomId && entry.roomAgentState);
  return {
    liveAgents: scoped.filter((entry) => !(entry.desiredState === "stopped" && entry.observedState === "stopped")),
    projectedSessionIds: new Set(
      scoped.map((entry) => entry.agentSessionId).filter((value): value is string => Boolean(value)),
    ),
  };
}

/**
 * Connection, delivery, and turn state are intentionally independent. This
 * classifier picks the one Activity grouping that best explains the agent's
 * current ability to receive room work without treating a heartbeat as work.
 */
export function roomAgentDeliveryGroup(
  agent: Pick<DesktopSupervisorManifestEntry, "roomAgentState">,
): RoomAgentDeliveryGroup {
  const state = agent.roomAgentState;
  if (!state) return "disconnected";
  // Additive protocol compatibility while Electron hands an older daemon to
  // 2.0.40. The successor always supplies the explicit ingress axis.
  const ingressState = state.ingress?.state ?? (state.connection.state === "connected" ? "observing" : "stopped");
  if (state.inbox.state === "waiting_for_desktop_credentials") return "attention";
  if (state.connection.state !== "connected") return "disconnected";
  if (ingressState === "backoff") return "disconnected";
  if (ingressState === "blocked") return "attention";
  if (ingressState !== "observing") return "disconnected";
  if (state.inbox.state === "blocked" || state.turn.state === "failed") return "attention";
  if (["dispatching", "responding", "publishing", "retrying"].includes(state.turn.state)) return "responding";
  return "listening";
}

export function roomAgentDeliverySummary(
  state: {
    connection: { state: DesktopRoomAgentConnectionState };
    ingress?: { state: DesktopRoomAgentIngressState };
    inbox: { state: DesktopRoomAgentInboxState };
    turn: { state: DesktopRoomAgentTurnState };
  },
): string {
  const ingressState = state.ingress?.state ?? (state.connection.state === "connected" ? "observing" : "stopped");
  if (state.inbox.state === "waiting_for_desktop_credentials") return "Waiting for desktop credential handoff";
  if (state.connection.state === "reconnecting") return "Reconnecting";
  if (state.connection.state === "disconnected") return "Disconnected";
  if (ingressState === "backoff") return "Reconnecting to room messages";
  if (ingressState === "blocked") return "Room observation needs attention";
  if (ingressState !== "observing") return "Starting room observation";
  if (state.inbox.state === "blocked" || state.turn.state === "failed") return "Delivery needs attention";
  if (["dispatching", "responding", "publishing", "retrying"].includes(state.turn.state)) return "Responding to a room message";
  return "Connected · Listening";
}

/**
 * Credential reconnect never creates a replacement. Render it only when the
 * renderer still has an exact current provider generation and worker binding
 * to rebind. The daemon repeats the stricter live-handle check at execution.
 */
export function canReconnectRoomAgent(
  agent: Pick<DesktopSupervisorManifestEntry,
    "deliveryMode" | "desiredState" | "roomAgentState" | "workAttemptId"
    | "agentSessionId" | "agentSessionBindingState" | "executionGenerationId"
    | "providerContinuationId">,
): boolean {
  return agent.deliveryMode === "daemon_inbox"
    && agent.desiredState === "running"
    && agent.roomAgentState?.inbox.state === "waiting_for_desktop_credentials"
    && agent.agentSessionBindingState === "active"
    && Boolean(agent.workAttemptId)
    && Boolean(agent.agentSessionId)
    && Boolean(agent.executionGenerationId)
    && Boolean(agent.providerContinuationId);
}

/** Explicit recovery restarts the same durable agent entry, never a reconnect fallback. */
export function canRecoverSavedRoomAgent(
  agent: Pick<DesktopSupervisorManifestEntry,
    "deliveryMode" | "desiredState" | "observedState" | "condition"
    | "executionGenerationId" | "providerContinuationId">,
): boolean {
  const recoveryState = ["absent", "paused", "failed", "recovering"].includes(agent.observedState)
    || agent.condition === "coordination_blocked"
    || agent.condition === "auth_blocked";
  return agent.deliveryMode === "daemon_inbox"
    && agent.desiredState !== "stopped"
    && recoveryState
    && (!agent.executionGenerationId || !agent.providerContinuationId);
}
