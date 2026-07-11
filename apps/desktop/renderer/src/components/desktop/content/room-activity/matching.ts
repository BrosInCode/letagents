import type {
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
} from "../../../../../../electron/ipc-types";
import { displayNameFromActor } from "../../../../domain/agents";

export function participantMatchesActor(
  actorLabel: string,
  displayName: string | null | undefined,
  value: string | null,
): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  return normalized === actorLabel || normalized === displayName || displayNameFromActor(normalized) === displayName;
}

export function participantMatchesHuman(
  participant: DesktopParticipantSummary,
  value: string | null,
): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(normalized && [participant.displayName, participant.githubLogin].some((candidate) => String(candidate || "").trim().toLowerCase() === normalized));
}

export function isHumanMessage(message: DesktopRoomMessage): boolean {
  if (message.source === "managed_agent_failure") return false;
  return message.source === "browser" || !message.agentIdentity;
}

export function latestStatusMessage(messages: DesktopRoomMessage[]): string | null {
  const message = [...messages].reverse().find((entry) => /^\[status\]\s*/i.test(entry.text || ""));
  return message ? message.text.replace(/^\[status\]\s*/i, "").trim() : null;
}

export function sessionMatchesAgent(
  actorLabel: string,
  label: string,
  session: DesktopReasoningSession,
): boolean {
  const sessionActor = String(session.actorLabel || "").trim();
  return sessionActor === actorLabel || displayNameFromActor(sessionActor) === label;
}
