import { formatDate, syncTimeZone, timeZoneEpoch } from "../../../../domain/formatters";
import { contributionChanges } from "../../../../domain/room-contributions";
import type { DesktopRoomAgentWork, DesktopRoomMessage, DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import { defaultSupervisedCharter } from "../add-agent/useAddAgentConfiguration";
import type { PresenceTimelineLine } from "./room-activity";

const compactContinuationWindowMs = 5 * 60 * 1000;

export type MessageTimelineEntry =
  | { type: "contribution"; id: string; work: DesktopRoomAgentWork }
  /** The first message an agent started on this Mac was given. Only its starter sees it. */
  | { type: "first-message"; id: string; agent: DesktopSupervisorManifestEntry }
  | { type: "agent-startup"; id: string; entryId: string }
  /** A quiet "Juniper joined" or "Juniper left" line, seen in this window only. */
  | { type: "presence"; id: string; line: PresenceTimelineLine }
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

interface TimelineItem {
  timestamp: string;
  time: number;
  id: string;
  message?: DesktopRoomMessage;
  work?: DesktopRoomAgentWork;
  agent?: DesktopSupervisorManifestEntry;
  startupEntryId?: string;
  presence?: PresenceTimelineLine;
}

/** An agent start-up row: under the person's first message to it, or at the time it started. */
export interface TimelineAgentStartup {
  entryId: string;
  anchorMessageId: string | null;
  startedAt: string;
}

/**
 * The agents whose first message belongs in the loaded part of the timeline.
 * The first message reaches the agent privately, so it is never a room
 * message; it is shown here, to the person who started the agent. The
 * window's generic first message is left out, and so is an agent started
 * before the oldest loaded message while older messages are still unloaded.
 */
export function firstMessageAgents(
  entries: readonly DesktopSupervisorManifestEntry[],
  messages: readonly DesktopRoomMessage[],
  hasOlderMessages: boolean,
): DesktopSupervisorManifestEntry[] {
  const oldest = hasOlderMessages && messages.length ? Math.min(...messages.map(message => Date.parse(message.timestamp)).filter(Number.isFinite)) : -Infinity;
  return entries.filter(entry => entry.createdBy === "desktop"
    && entry.charter.trim()
    && entry.charter.trim() !== defaultSupervisedCharter
    && Number.isFinite(Date.parse(entry.createdAt))
    && Date.parse(entry.createdAt) >= oldest);
}

export function buildMessageTimelineEntries(
  messages: readonly DesktopRoomMessage[],
  work: readonly DesktopRoomAgentWork[] = [],
  presence: readonly PresenceTimelineLine[] = [],
  startups: readonly TimelineAgentStartup[] = [],
  firstMessages: readonly DesktopSupervisorManifestEntry[] = [],
): MessageTimelineEntry[] {
  const entries: MessageTimelineEntry[] = [];
  let previousDayKey: string | null = null;
  let previousMessage: DesktopRoomMessage | null = null;
  let previousTime = NaN;
  refreshDayCaches();

  // Each timestamp is parsed once here. The sort comparator used to parse both
  // sides on every comparison.
  const ordered: TimelineItem[] = messages.map(message => ({
    timestamp: message.timestamp, time: Date.parse(message.timestamp), id: message.id, message,
  }));
  if (work.length) {
    const sources = new Map(messages.map(message => [message.id, message.timestamp]));
    for (const entry of work) {
      const changes = contributionChanges(entry);
      if (!changes || !sources.has(entry.sourceMessageId)) continue;
      const captured = changes.captured_at;
      const source = sources.get(entry.sourceMessageId)!;
      // A host clock behind the room server must not put a result before its cause.
      const timestamp = Date.parse(source) > Date.parse(captured) ? source : captured;
      ordered.push({ timestamp, time: Date.parse(timestamp), id: `contribution:${entry.attemptId}`, work: entry });
    }
  }
  // Before the start-up rows, so a first message comes first at the same time.
  for (const agent of firstMessages) {
    ordered.push({ timestamp: agent.createdAt, time: Date.parse(agent.createdAt), id: `first-message:${agent.id}`, agent });
  }
  for (const line of presence) {
    ordered.push({ timestamp: line.timestamp, time: Date.parse(line.timestamp), id: line.id, presence: line });
  }
  const anchoredStartups: Array<{ item: TimelineItem; anchorId: string }> = [];
  if (startups.length) {
    const sources = new Map(messages.map(message => [message.id, message.timestamp]));
    for (const startup of startups) {
      const anchor = startup.anchorMessageId && sources.has(startup.anchorMessageId) ? startup.anchorMessageId : null;
      const timestamp = anchor ? sources.get(anchor)! : startup.startedAt;
      const item: TimelineItem = { timestamp, time: Date.parse(timestamp), id: `agent-startup:${startup.entryId}`, startupEntryId: startup.entryId };
      // A row with its first message goes right under that message, after the sort.
      if (anchor) anchoredStartups.push({ item, anchorId: anchor });
      else ordered.push(item);
    }
  }
  // Messages usually arrive in order. A sorted list (with no unparsable time,
  // which makes the comparator inconsistent) is already its own sort result.
  let sorted = true;
  for (let index = 1; index < ordered.length; index += 1) {
    if (!(ordered[index - 1]!.time <= ordered[index]!.time)) { sorted = false; break; }
  }
  if (!sorted) ordered.sort((a, b) => a.time - b.time);
  for (const { item, anchorId } of anchoredStartups) {
    let index = ordered.findIndex(candidate => candidate.message?.id === anchorId) + 1;
    while (ordered[index]?.startupEntryId) index += 1;
    ordered.splice(index, 0, item);
  }
  for (const item of ordered) {
    const dayKey = messageDayKey(item.timestamp);
    if (dayKey !== previousDayKey) {
      entries.push({
        type: "date",
        id: `date:${dayKey}:${item.id}`,
        label: dividerLabel(dayKey, item.timestamp),
        dateTime: dayKey,
      });
      previousDayKey = dayKey;
      previousMessage = null;
    }

    if (item.agent) {
      entries.push({ type: "first-message", id: item.id, agent: item.agent });
      previousMessage = null;
      continue;
    }
    if (item.startupEntryId) {
      entries.push({ type: "agent-startup", id: item.id, entryId: item.startupEntryId });
      previousMessage = null;
      continue;
    }
    if (item.presence) {
      entries.push({ type: "presence", id: item.id, line: item.presence });
      previousMessage = null;
      continue;
    }
    if (item.work) {
      entries.push({ type: "contribution", id: item.id, work: item.work });
      previousMessage = null;
      continue;
    }
    const message = item.message!;
    entries.push({
      type: "message",
      id: message.id,
      message,
      compactWithPrevious: shouldCompactWithPrevious(previousMessage, message, previousTime, item.time),
    });
    previousMessage = message;
    previousTime = item.time;
  }

  return entries;
}

function shouldCompactWithPrevious(
  previousMessage: DesktopRoomMessage | null,
  message: DesktopRoomMessage,
  previousTime: number,
  currentTime: number,
): boolean {
  if (!previousMessage) return false;
  // The time test is the cheapest and fails for most pairs, so it runs first.
  // `previousTime` and `currentTime` are the parsed timestamps of the two.
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousTime)) return false;
  const elapsed = currentTime - previousTime;
  if (!(elapsed >= 0 && elapsed <= compactContinuationWindowMs)) return false;
  if (message.replyTo || previousMessage.replyTo) return false;
  if (message.attachments.length || previousMessage.attachments.length) return false;
  if (message.thread?.replyCount || previousMessage.thread?.replyCount) return false;
  if (isNonConversationalMessage(message) || isNonConversationalMessage(previousMessage)) return false;
  return messageSenderKey(message) === messageSenderKey(previousMessage);
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

// Day keys and divider labels depend only on the timestamp and the local time
// zone. They are cached by timestamp string and by day key.
//
// Invalidation: both caches are cleared when the time zone changes, and when they pass the size bound.
const maxCachedDayKeys = 20_000;
const dayKeyByTimestamp = new Map<string, string>();
const dividerLabelByDayKey = new Map<string, string>();

/** Counts cache fills so tests can prove a timestamp is formatted once. */
export const timelineFormatBuilds = { dayKeys: 0, dividerLabels: 0 };

let seenZoneEpoch = 0;

function refreshDayCaches(): void {
  // One zone check per build. It also drops the shared date formats.
  syncTimeZone(true);
  if (seenZoneEpoch !== timeZoneEpoch.value) {
    seenZoneEpoch = timeZoneEpoch.value;
    dayKeyByTimestamp.clear();
    dividerLabelByDayKey.clear();
  }
}

function messageDayKey(timestamp: string): string {
  const cached = dayKeyByTimestamp.get(timestamp);
  if (cached !== undefined) return cached;
  timelineFormatBuilds.dayKeys += 1;
  const date = new Date(timestamp);
  let key: string;
  if (Number.isNaN(date.getTime())) {
    key = "unknown";
  } else {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    key = `${year}-${month}-${day}`;
  }
  if (dayKeyByTimestamp.size >= maxCachedDayKeys) dayKeyByTimestamp.clear();
  dayKeyByTimestamp.set(timestamp, key);
  return key;
}

function dividerLabel(dayKey: string, timestamp: string): string {
  const cached = dividerLabelByDayKey.get(dayKey);
  if (cached !== undefined) return cached;
  timelineFormatBuilds.dividerLabels += 1;
  const label = formatDateDivider(timestamp);
  if (dividerLabelByDayKey.size >= maxCachedDayKeys) dividerLabelByDayKey.clear();
  dividerLabelByDayKey.set(dayKey, label);
  return label;
}

function formatDateDivider(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return formatDate("dateDivider", date);
}
