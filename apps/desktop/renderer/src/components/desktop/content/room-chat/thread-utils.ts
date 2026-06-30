import type {
  DesktopRoomMessage,
  DesktopRoomMessageReply,
  DesktopRoomMessageThreadParticipant,
} from "../../../../../../electron/ipc-types";

export interface ThreadSummary {
  count: number;
  latest: DesktopRoomMessage | null;
  replies: DesktopRoomMessage[];
}

export interface ThreadParticipantSummary {
  key: string;
  displayName: string;
  color: string | null;
}

export interface ThreadIndicatorSummary {
  count: number;
  unreadCount: number;
  latest: DesktopRoomMessage | null;
  latestPreview: string | null;
  latestTimestamp: string | null;
  participants: ThreadParticipantSummary[];
  hasPartialHistory: boolean;
  loadingEarlier: boolean;
}

export interface ThreadReadState {
  unreadCount: number;
  firstUnreadReplyId: string | null;
}

export function buildThreadSummaries(messages: readonly DesktopRoomMessage[]): Map<string, ThreadSummary> {
  const summaries = new Map<string, ThreadSummary>();
  for (const message of messages) {
    const parentId = threadParentId(message);
    if (!parentId) continue;
    const summary = summaries.get(parentId) || { count: 0, latest: null, replies: [] };
    summary.count += 1;
    summary.replies.push(message);
    if (!summary.latest || timestampValue(message) >= timestampValue(summary.latest)) {
      summary.latest = message;
    }
    summaries.set(parentId, summary);
  }
  return summaries;
}

export function threadReplies(messages: readonly DesktopRoomMessage[], parentId: string | null): DesktopRoomMessage[] {
  if (!parentId) return [];
  return messages.filter((message) => threadParentId(message) === parentId);
}

export function roomTimelineMessages(messages: readonly DesktopRoomMessage[]): DesktopRoomMessage[] {
  return messages.filter((message) => !threadParentId(message));
}

export function resolveThreadParent(
  messages: readonly DesktopRoomMessage[],
  parentId: string | null,
): DesktopRoomMessage | null {
  if (!parentId) return null;
  const loadedParent = messages.find((message) => message.id === parentId);
  if (loadedParent) return loadedParent;

  const replySnapshot = messages.find((message) =>
    threadParentId(message) === parentId && message.replyTo?.id === parentId
  )?.replyTo;
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
    threadRootId: replySnapshot.id,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
  };
}

export function buildThreadIndicatorSummary(
  parent: DesktopRoomMessage,
  fallback: ThreadSummary | null,
): ThreadIndicatorSummary {
  const thread = parent.thread;
  const metadataLatest = thread?.latestReply ? threadReplyToMessage(thread.latestReply) : null;
  const fallbackLatest = fallback?.latest || null;
  const latest = newerThreadMessage(metadataLatest, fallbackLatest);
  const metadataCount = thread?.replyCount;
  const fallbackCount = fallback?.count ?? 0;
  const count = Math.max(metadataCount ?? 0, fallbackCount);
  const fallbackIsLatest = Boolean(fallbackLatest && latest?.id === fallbackLatest.id);
  const readUntilId = thread?.lastReadMessageId || null;
  return {
    count,
    unreadCount: Math.max(
      thread?.unreadCount ?? 0,
      fallbackUnreadCount(parent, fallback, readUntilId, metadataCount),
    ),
    latest,
    latestPreview: fallbackIsLatest
      ? fallbackLatest?.text || null
      : metadataLatest?.text || latest?.text || null,
    latestTimestamp: latest?.timestamp || null,
    participants: parseThreadParticipants(thread?.participants ?? []),
    hasPartialHistory: false,
    loadingEarlier: false,
  };
}

export function threadReadState(
  parent: DesktopRoomMessage,
  replies: readonly DesktopRoomMessage[],
): ThreadReadState {
  const unreadCount = parent.thread?.unreadCount ?? 0;
  if (unreadCount <= 0) {
    return {
      unreadCount,
      firstUnreadReplyId: null,
    };
  }

  const readUntilId = parent.thread?.lastReadMessageId || null;
  if (readUntilId) {
    const readUntilIndex = replies.findIndex((reply) => reply.id === readUntilId);
    const firstUnreadReply = readUntilIndex >= 0 ? replies[readUntilIndex + 1] : replies[0];
    return {
      unreadCount,
      firstUnreadReplyId: firstUnreadReply?.id || null,
    };
  }

  if (replies.length >= unreadCount) {
    const firstUnreadReply = replies[Math.max(0, replies.length - unreadCount)];
    return {
      unreadCount,
      firstUnreadReplyId: firstUnreadReply?.id || null,
    };
  }

  return {
    unreadCount,
    firstUnreadReplyId: null,
  };
}

export function threadQuotePreview(message: DesktopRoomMessage): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  if (text) return truncateThreadText(text, 140);
  if (message.attachments.length === 1) return "1 attachment";
  if (message.attachments.length > 1) return `${message.attachments.length} attachments`;
  return "No message body.";
}

export function applyThreadQuoteToDraft(draft: string, quote: DesktopRoomMessage | null): string {
  const text = draft.trim();
  if (!quote) return text;
  const sender = quote.agentIdentity?.displayName || quote.sender;
  return `> ${sender}: ${threadQuotePreview(quote)}\n\n${text}`;
}

export function threadParentId(message: DesktopRoomMessage): string | null {
  if (message.threadRootId && message.threadRootId !== message.id) {
    return message.threadRootId;
  }
  return null;
}

function timestampValue(message: DesktopRoomMessage | null | undefined): number {
  if (!message) return 0;
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newerThreadMessage(
  metadataLatest: DesktopRoomMessage | null,
  fallbackLatest: DesktopRoomMessage | null,
): DesktopRoomMessage | null {
  if (!metadataLatest) return fallbackLatest;
  if (!fallbackLatest) return metadataLatest;
  return timestampValue(fallbackLatest) >= timestampValue(metadataLatest) ? fallbackLatest : metadataLatest;
}

function fallbackUnreadCount(
  parent: DesktopRoomMessage,
  fallback: ThreadSummary | null,
  readUntilId: string | null,
  metadataCount: number | undefined,
): number {
  if (!fallback?.count) return 0;
  if (readUntilId === parent.id) return fallback.count;

  const readUntilIndex = readUntilId
    ? fallback.replies.findIndex((reply) => reply.id === readUntilId)
    : -1;
  if (readUntilIndex >= 0) {
    return Math.max(0, fallback.replies.length - readUntilIndex - 1);
  }
  if (readUntilId && fallback.latest?.id === readUntilId) {
    return 0;
  }

  return metadataCount === undefined ? 0 : Math.max(0, fallback.count - metadataCount);
}

function parseThreadParticipants(participants: DesktopRoomMessageThreadParticipant[]): ThreadParticipantSummary[] {
  return participants.slice(0, 4).map((participant, index) => {
    const displayName = displayNameFromParticipantSender(participant.sender);
    return {
      key: participant.sender || `${displayName}-${index}`,
      displayName,
      color: null,
    };
  });
}

function displayNameFromParticipantSender(value: string): string {
  const [displayName] = value.split(" | ");
  return displayName.trim() || value.trim();
}

function threadReplyToMessage(reply: DesktopRoomMessageReply): DesktopRoomMessage {
  return {
    id: reply.id,
    sender: reply.sender,
    text: reply.text,
    attachments: [],
    agentPromptKind: null,
    source: reply.source,
    timestamp: reply.timestamp,
    actorLabel: null,
    agentIdentity: null,
    threadRootId: reply.id,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
  };
}

function truncateThreadText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
