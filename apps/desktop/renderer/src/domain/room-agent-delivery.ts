import type { DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";

export type RoomAgentDeliveryGroup = "listening" | "responding" | "attention" | "disconnected";

/**
 * Connection, delivery, and turn state are intentionally independent. This
 * classifier picks the one Activity grouping that best explains the agent's
 * current ability to receive room work without treating a heartbeat as work.
 */
export function roomAgentDeliveryGroup(
  agent: Pick<DesktopSupervisorManifestEntry, "roomAgentState">,
): RoomAgentDeliveryGroup {
  const state = agent.roomAgentState;
  if (!state || state.connection.state === "disconnected") return "disconnected";
  if (state.inbox.state === "blocked" || state.turn.state === "failed") return "attention";
  if (["dispatching", "responding", "publishing", "retrying"].includes(state.turn.state)) return "responding";
  return "listening";
}
