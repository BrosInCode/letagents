import type { AgentModalTarget } from "../desktop-chat-message/types";
import type { ActivityParticipant } from "./types";

export function activityParticipantToAgentTarget(
  participant: ActivityParticipant,
): AgentModalTarget {
  const displayName = participant.label || participant.actorLabel || "Agent";
  return {
    messageId: null,
    clientMessageId: null,
    messageSource: null,
    actorLabel: participant.actorLabel,
    displayName,
    ownerAttribution: ownerAttribution(participant.ownerLabel),
    ideLabel: participant.ideLabel || participant.runtime,
    sender: participant.actorLabel || displayName,
    agentKey: participant.agentKey,
    agentSessionId: participant.agentSessionId,
  };
}

export function ownerAttribution(ownerLabel: string | null): string | null {
  const trimmed = ownerLabel?.trim();
  if (!trimmed) return null;
  return /'s agent$/i.test(trimmed) ? trimmed : `${trimmed}'s agent`;
}
