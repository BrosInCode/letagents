import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";

export interface ThreadSummary {
  count: number;
  latest: DesktopRoomMessage | null;
}

export interface ThreadActivity {
  parent: DesktopRoomMessage;
  latest: DesktopRoomMessage;
  count: number;
}

export function buildThreadSummaries(messages: readonly DesktopRoomMessage[]): Map<string, ThreadSummary> {
  const summaries = new Map<string, ThreadSummary>();
  for (const message of messages) {
    const parentId = message.replyTo?.id;
    if (!parentId) continue;
    const summary = summaries.get(parentId) || { count: 0, latest: null };
    summary.count += 1;
    if (!summary.latest || timestampValue(message) >= timestampValue(summary.latest)) {
      summary.latest = message;
    }
    summaries.set(parentId, summary);
  }
  return summaries;
}

export function threadReplies(messages: readonly DesktopRoomMessage[], parentId: string | null): DesktopRoomMessage[] {
  if (!parentId) return [];
  return messages.filter((message) => message.replyTo?.id === parentId);
}

export function roomTimelineMessages(messages: readonly DesktopRoomMessage[]): DesktopRoomMessage[] {
  return messages.filter((message) => !message.replyTo?.id);
}

export function resolveThreadParent(
  messages: readonly DesktopRoomMessage[],
  parentId: string | null,
): DesktopRoomMessage | null {
  if (!parentId) return null;
  const loadedParent = messages.find((message) => message.id === parentId);
  if (loadedParent) return loadedParent;

  const replySnapshot = messages.find((message) => message.replyTo?.id === parentId)?.replyTo;
  if (!replySnapshot) return null;

  return {
    id: replySnapshot.id,
    sender: replySnapshot.sender,
    text: replySnapshot.text,
    attachments: [],
    agentPromptKind: null,
    source: replySnapshot.source,
    timestamp: replySnapshot.timestamp,
    actorLabel: null,
    agentIdentity: null,
    replyTo: null,
  };
}

export function recentThreadActivities(
  messages: readonly DesktopRoomMessage[],
  limit = 3,
): ThreadActivity[] {
  const summaries = buildThreadSummaries(messages);
  return [...summaries.entries()]
    .flatMap(([parentId, summary]) => {
      if (!summary.latest) return [];
      const parent = resolveThreadParent(messages, parentId);
      return parent ? [{ parent, latest: summary.latest, count: summary.count }] : [];
    })
    .sort((left, right) => timestampValue(right.latest) - timestampValue(left.latest))
    .slice(0, limit);
}

function timestampValue(message: DesktopRoomMessage): number {
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}
