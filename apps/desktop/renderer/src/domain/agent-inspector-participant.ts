import type { AgentInspectorSelection } from "../components/desktop/content/desktop-chat-message/types";

/**
 * A room participant the desktop does not supervise. Its runtime and
 * permissions are managed elsewhere, so the inspector shows what the room
 * shares about it and nothing it cannot control.
 */
export type AgentInspectorParticipantProjection = {
  kind: "external";
  title: string;
  eyebrow: "Room participant";
  heading: string;
  detail: string;
};

export interface AgentInspectorStatusProjection {
  title: string;
  eyebrow: "Agent" | "Room participant";
  heading: string;
  detail: string;
  canRetry: boolean;
}

/**
 * Project unresolved Inspector state into stable product copy. Transport
 * errors remain in the resource layer for diagnostics and are never rendered
 * as though they describe the selected agent.
 */
export function projectAgentInspectorStatus(
  selection: AgentInspectorSelection,
): AgentInspectorStatusProjection {
  const title = selection.displayName || selection.sender || "Agent";
  if (selection.kind === "resolving") {
    return {
      title,
      eyebrow: "Agent",
      heading: "Loading agent details",
      detail: "Checking the background service for this agent’s durable identity.",
      canRetry: false,
    };
  }
  if (selection.kind === "unavailable" && selection.unavailableReason === "load_error") {
    return {
      title,
      eyebrow: "Agent",
      heading: "Couldn’t load agent details",
      detail: "LetAgents couldn’t reach its background agent service. The agent’s room history is still available, and you can try again.",
      canRetry: true,
    };
  }
  if (selection.kind === "unavailable" && selection.unavailableReason === "ambiguous") {
    return {
      title,
      eyebrow: "Agent",
      heading: "Agent identity unavailable",
      detail: "Conflicting exact supervised identities were found. Controls are withheld until the identity is unambiguous.",
      canRetry: false,
    };
  }
  if (selection.kind === "external") {
    return {
      title,
      eyebrow: "Room participant",
      heading: "Externally managed agent",
      detail: "This participant is visible in the room, but it is not controlled by this desktop supervisor.",
      canRetry: false,
    };
  }
  return {
    title,
    eyebrow: "Agent",
    heading: "Agent no longer available",
    detail: "This agent is no longer managed by this desktop. Its room messages remain available in history.",
    canRetry: false,
  };
}

export function projectAgentInspectorParticipant(
  selection: AgentInspectorSelection,
): AgentInspectorParticipantProjection | null {
  if (selection.kind !== "external") return null;
  return {
    kind: "external",
    title: selection.displayName || selection.sender || "Agent",
    eyebrow: "Room participant",
    heading: "Externally managed agent",
    detail: "This participant is visible in this room, but its runtime and permissions are managed elsewhere.",
  };
}
