import { readableContributionText } from "../../../../../shared/contribution-text.mjs";
import type { DesktopParticipantSummary, DesktopRoomAgentWork } from '../../../electron/ipc-types';
import type { AgentModalTarget } from '../components/desktop/content/desktop-chat-message/types';
import { resolveOwnerAttribution } from '../components/desktop/content/desktop-chat-message/identity';
export function contributionChanges(work: DesktopRoomAgentWork) {
  return 'contribution' in work.summary ? work.summary.contribution?.changes : undefined;
}
export function workspaceAgentTarget(work: DesktopRoomAgentWork, participants: readonly DesktopParticipantSummary[]): AgentModalTarget {
  const participant = participants.find(item => item.agentKey === work.agentKey);
  const name = participant?.displayName || work.agentKey.split('/').at(-1) || 'Agent';
  return { workspaceSourceMessageId: work.sourceMessageId, messageId: null, clientMessageId: null, messageSource: 'agent', actorLabel: participant?.actorLabel ?? null,
    displayName: name, ownerAttribution: resolveOwnerAttribution(participant ?? {}), ideLabel: participant?.ideLabel ?? null,
    sender: participant?.actorLabel || name, agentKey: work.agentKey, agentSessionId: null };
}
export function contributionSummary(work: DesktopRoomAgentWork): string {
  const contribution = 'contribution' in work.summary ? work.summary.contribution : undefined;
  const summary = readableContributionText(contribution?.summary);
  if (summary) return summary;
  const files = contribution?.changes.files ?? [];
  return files.slice(0, 3).map(file => `${({ added: 'Added', untracked: 'Added', deleted: 'Deleted', renamed: 'Renamed' } as Record<string, string>)[file.status] ?? 'Updated'} ${file.path.split('/').at(-1)}`).join(' · ')
    + (files.length > 3 ? ` · ${files.length - 3} more files` : '');
}
