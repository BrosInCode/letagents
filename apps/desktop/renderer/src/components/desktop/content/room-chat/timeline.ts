import { contributionChanges } from "../../../../domain/room-contributions";
import type { DesktopRoomAgentWork, DesktopRoomMessage } from "../../../../../../electron/ipc-types";

const compactContinuationWindowMs = 5 * 60 * 1000;

export type MessageTimelineEntry =
  | { type: "contribution"; id: string; work: DesktopRoomAgentWork }
  | {
      type: "date";
      id: string;
      label: string;
      dateTime: string;
    }
  | {
      type: "message";
      id: string;
      message: DesktopRoomMessage;
      compactWithPrevious: boolean;
    };

export function buildMessageTimelineEntries(messages: readonly DesktopRoomMessage[], work: readonly DesktopRoomAgentWork[] = []): MessageTimelineEntry[] {
  const entries: MessageTimelineEntry[] = [];
  let previousDayKey: string | null = null;
  let previousMessage: DesktopRoomMessage | null = null;

  const sources = new Set(messages.map(message => message.id));
  const contributions = work.filter(entry => {
    const changes = contributionChanges(entry);
    return sources.has(entry.sourceMessageId) && changes && (changes.state !== 'ready' || changes.files.length + changes.hidden_files > 0);
  });
  const ordered = [...messages.map(message => ({ timestamp: message.timestamp, id: message.id, message })),
    ...contributions.map(work => ({ timestamp: contributionChanges(work)!.captured_at, id: `contribution:${work.attemptId}`, work }))]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const item of ordered) {
    const dayKey = messageDayKey(item.timestamp);
    if (dayKey !== previousDayKey) {
      entries.push({
        type: "date",
        id: `date:${dayKey}:${item.id}`,
        label: formatDateDivider(item.timestamp),
        dateTime: dayKey,
      });
      previousDayKey = dayKey;
      previousMessage = null;
    }

    if ('work' in item) {
      entries.push({ type: "contribution", id: item.id, work: item.work });
      previousMessage = null;
      continue;
    }
    const message = item.message;
    entries.push({
      type: "message",
      id: message.id,
      message,
      compactWithPrevious: shouldCompactWithPrevious(previousMessage, message),
    });
    previousMessage = message;
  }

  return entries;
}

function shouldCompactWithPrevious(
  previousMessage: DesktopRoomMessage | null,
  message: DesktopRoomMessage,
): boolean {
  if (!previousMessage) return false;
  if (message.replyTo || previousMessage.replyTo) return false;
  if (message.attachments.length || previousMessage.attachments.length) return false;
  if (message.thread?.replyCount || previousMessage.thread?.replyCount) return false;
  if (isNonConversationalMessage(message) || isNonConversationalMessage(previousMessage)) return false;
  if (messageSenderKey(message) !== messageSenderKey(previousMessage)) return false;

  const currentTime = Date.parse(message.timestamp);
  const previousTime = Date.parse(previousMessage.timestamp);
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousTime)) return false;
  const elapsed = currentTime - previousTime;
  return elapsed >= 0 && elapsed <= compactContinuationWindowMs;
}

function isNonConversationalMessage(message: DesktopRoomMessage): boolean {
  const sender = message.sender.toLowerCase();
  return message.source === "github" || sender === "github" || sender === "system" || sender === "letagents";
}

function messageSenderKey(message: DesktopRoomMessage): string {
  return [
    message.source,
    message.agentIdentity?.actorLabel || message.actorLabel || message.sender,
  ].join(":");
}

function messageDayKey(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateDivider(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
