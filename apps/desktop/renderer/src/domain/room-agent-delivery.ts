import type {
  DesktopRoomAgentConnectionState,
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
  if (state.inbox.state === "waiting_for_desktop_credentials") return "attention";
  if (state.connection.state !== "connected") return "disconnected";
  if (state.inbox.state === "blocked" || state.turn.state === "failed") return "attention";
  if (["dispatching", "responding", "publishing", "retrying"].includes(state.turn.state)) return "responding";
  return "listening";
}

export function roomAgentDeliverySummary(
  state: {
    connection: { state: DesktopRoomAgentConnectionState };
    inbox: { state: DesktopRoomAgentInboxState };
    turn: { state: DesktopRoomAgentTurnState };
  },
): string {
  if (state.inbox.state === "waiting_for_desktop_credentials") return "Waiting for desktop credential handoff";
  if (state.connection.state === "reconnecting") return "Reconnecting";
  if (state.connection.state === "disconnected") return "Disconnected";
  if (state.inbox.state === "blocked" || state.turn.state === "failed") return "Delivery needs attention";
  if (["dispatching", "responding", "publishing", "retrying"].includes(state.turn.state)) return "Responding to a room message";
  return "Connected · Listening";
}
