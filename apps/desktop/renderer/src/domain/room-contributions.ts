import { hasReviewableRoomContribution } from "../../../../../shared/room-agent-work.mjs";
import { parseAgentLabel } from "../../../../../shared/ui/agent-label";
import type { DesktopParticipantSummary, DesktopRoomAgentWork, DesktopRoomMessage } from '../../../electron/ipc-types';
import type { AgentModalTarget } from '../components/desktop/content/desktop-chat-message/types';
import { resolveOwnerAttribution } from '../components/desktop/content/desktop-chat-message/identity';
export function contributionChanges(work: DesktopRoomAgentWork) {
  return 'contribution' in work.summary && hasReviewableRoomContribution(work.summary) ? work.summary.contribution?.changes : undefined;
}
export function workspaceAgentTarget(
  work: DesktopRoomAgentWork,
  participants: readonly DesktopParticipantSummary[],
  sourceMessage?: Pick<DesktopRoomMessage, "id" | "sender" | "actorLabel" | "agentIdentity">,
): AgentModalTarget {
  const participant = participants.find(item => item.kind === 'agent' && item.agentKey === work.agentKey);
  // A workspace card can be anchored beneath someone else's message that
  // triggered the work. Use historical attribution only for the same agent.
  const publisher = sourceMessage?.id === work.sourceMessageId && sourceMessage.agentIdentity?.agentKey === work.agentKey
    ? sourceMessage.agentIdentity
    : null;
  const participantLabel = parseAgentLabel(participant?.actorLabel);
  const publisherLabel = parseAgentLabel(publisher && (publisher.actorLabel || sourceMessage?.actorLabel || sourceMessage?.sender));
  const isReadableName = (name?: string | null): name is string => Boolean(name
    && !(work.agentKey.includes('/') && name === work.agentKey)
    && !/^(?:[^/\s]+\/)*worker-[a-f0-9]{32,}$/i.test(name)
    && !/^(?:agent|supervisor worker)$/i.test(name));
  const name = [
    participant?.displayName?.trim(), participantLabel.displayName,
    publisher?.displayName?.trim(), publisherLabel.displayName,
  ].find(isReadableName) ?? 'Agent';
  const actorLabel = [participantLabel, publisherLabel].find(label => isReadableName(label.displayName))?.raw ?? null;
  return {
    workspaceSourceMessageId: work.sourceMessageId, messageId: null, clientMessageId: null, messageSource: 'agent',
    actorLabel, displayName: name, sender: actorLabel || name, agentKey: work.agentKey, agentSessionId: null,
    ownerAttribution: resolveOwnerAttribution(participant ?? {}) || resolveOwnerAttribution(publisher ?? {}) || publisherLabel.ownerAttribution,
    ideLabel: participant?.ideLabel || publisher?.ideLabel || null,
  };
}
