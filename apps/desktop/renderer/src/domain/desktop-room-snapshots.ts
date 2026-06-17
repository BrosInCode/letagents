import type {
  DesktopGitHubEventsPage,
  DesktopGitHubRoomEvent,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomSnapshot,
  DesktopTaskSummary,
} from "../../../electron/ipc-types";
import { normalizeRoomIdentifier } from "./sidebar-rooms";

export function snapshotMatchesRoom(snapshot: DesktopRoomSnapshot | null, roomIdentifier: string | null): boolean {
  if (!roomIdentifier || !snapshot) return false;
  const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
  return [
    snapshot.roomIdentifier,
    snapshot.room?.identifier,
    snapshot.room?.name,
    snapshot.room?.code,
  ].some((candidate) => normalizeRoomIdentifier(candidate) === normalizedRoomIdentifier);
}

export function upsertSnapshotTask(
  snapshot: DesktopRoomSnapshot | null,
  task: DesktopTaskSummary
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  const existingIndex = snapshot.tasks.findIndex((existing) => existing.id === task.id);
  const tasks = [...snapshot.tasks];
  if (existingIndex >= 0) {
    tasks.splice(existingIndex, 1, { ...tasks[existingIndex], ...task });
  } else {
    tasks.unshift(task);
  }
  return {
    ...snapshot,
    tasks,
  };
}

export function upsertSnapshotReasoningSession(
  snapshot: DesktopRoomSnapshot | null,
  session: DesktopReasoningSession
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  const existingIndex = snapshot.reasoningSessions.findIndex((existing) => existing.id === session.id);
  const reasoningSessions = [...snapshot.reasoningSessions];
  if (existingIndex >= 0) {
    reasoningSessions.splice(existingIndex, 1, { ...reasoningSessions[existingIndex], ...session });
  } else {
    reasoningSessions.unshift(session);
  }
  reasoningSessions.sort(compareDesktopReasoningSessions);
  return {
    ...snapshot,
    reasoningSessions,
  };
}

export function removeSnapshotReasoningSession(
  snapshot: DesktopRoomSnapshot | null,
  sessionId: string
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    reasoningSessions: snapshot.reasoningSessions.filter((session) => session.id !== sessionId),
  };
}

export function appendSnapshotMessage(
  snapshot: DesktopRoomSnapshot | null,
  message: DesktopRoomMessage
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    messages: mergeDesktopRoomMessages(snapshot.messages || [], [message]),
  };
}

export function upsertSnapshotGitHubEvent(
  snapshot: DesktopRoomSnapshot | null,
  event: DesktopGitHubRoomEvent
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  const currentPage = snapshot.githubEvents || {
    roomIdentifier: snapshot.roomIdentifier || snapshot.room?.identifier || "",
    githubRoomIdentifier: null,
    events: [],
    hasMore: false,
  };
  return {
    ...snapshot,
    githubEvents: {
      ...currentPage,
      events: mergeDesktopGitHubEvents(currentPage.events, [event]),
    },
  };
}

export function mergeRoomSnapshotMessages(
  current: DesktopRoomSnapshot | null,
  incoming: DesktopRoomSnapshot
): DesktopRoomSnapshot {
  if (!current || !roomSnapshotsMatch(current, incoming)) return incoming;
  if (shouldPreserveCurrentRoomSnapshot(current, incoming)) {
    return {
      ...current,
      messages: mergeDesktopRoomMessages(current.messages || [], incoming.messages || []),
      githubEvents: mergeDesktopGitHubEventsPage(current.githubEvents, incoming.githubEvents),
    };
  }
  if (!snapshotStorageNamespacesMatch(current, incoming)) return incoming;
  return {
    ...incoming,
    messages: mergeDesktopRoomMessages(current.messages || [], incoming.messages || []),
    githubEvents: mergeDesktopGitHubEventsPage(current.githubEvents, incoming.githubEvents),
  };
}

export function roomSnapshotsMatch(left: DesktopRoomSnapshot, right: DesktopRoomSnapshot): boolean {
  const leftIdentifiers = [
    left.roomIdentifier,
    left.room?.identifier,
    left.room?.name,
    left.room?.code,
  ].map(normalizeRoomIdentifier).filter(Boolean);
  const rightIdentifiers = [
    right.roomIdentifier,
    right.room?.identifier,
    right.room?.name,
    right.room?.code,
  ].map(normalizeRoomIdentifier).filter(Boolean);
  return leftIdentifiers.some((identifier) => rightIdentifiers.includes(identifier));
}

export function mergeDesktopRoomMessages(
  current: readonly DesktopRoomMessage[],
  incoming: readonly DesktopRoomMessage[]
): DesktopRoomMessage[] {
  const byId = new Map<string, DesktopRoomMessage>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) {
    if (!isPromptOnlyDesktopMessage(message)) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort(compareDesktopRoomMessages);
}

export function mergeDesktopGitHubEventsPage(
  current: DesktopGitHubEventsPage | null,
  incoming: DesktopGitHubEventsPage | null,
): DesktopGitHubEventsPage | null {
  if (!current) return incoming;
  if (!incoming) return current;
  return {
    ...incoming,
    events: mergeDesktopGitHubEvents(current.events, incoming.events),
    hasMore: incoming.hasMore,
  };
}

export function mergeDesktopGitHubEvents(
  current: readonly DesktopGitHubRoomEvent[],
  incoming: readonly DesktopGitHubRoomEvent[],
): DesktopGitHubRoomEvent[] {
  const byId = new Map<string, DesktopGitHubRoomEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(compareDesktopGitHubEvents);
}

export function shouldRefreshMetadataForMessage(message: DesktopRoomMessage): boolean {
  const source = (message.source || "").toLowerCase();
  const sender = (message.sender || "").toLowerCase();
  return source === "agent" || source === "browser" || source === "github" || sender === "letagents" || sender === "github";
}

function compareDesktopGitHubEvents(left: DesktopGitHubRoomEvent, right: DesktopGitHubRoomEvent): number {
  const leftTime = Date.parse(left.createdAt || "");
  const rightTime = Date.parse(right.createdAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.id.localeCompare(left.id);
}

function shouldPreserveCurrentRoomSnapshot(
  current: DesktopRoomSnapshot,
  incoming: DesktopRoomSnapshot
): boolean {
  if (current.access.status !== "ready" || incoming.access.status !== "unavailable") return false;
  const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
  return incoming.access.httpStatus === null || transientStatuses.has(incoming.access.httpStatus);
}

function snapshotStorageNamespacesMatch(
  current: DesktopRoomSnapshot,
  incoming: DesktopRoomSnapshot
): boolean {
  const currentStorage = current.storage;
  const incomingStorage = incoming.storage;
  if (currentStorage.effectiveMode !== incomingStorage.effectiveMode) return false;
  if (currentStorage.effectiveMode !== "local") return true;
  return normalizeRoomIdentifier(currentStorage.localRoom?.roomIdentifier) ===
    normalizeRoomIdentifier(incomingStorage.localRoom?.roomIdentifier);
}

function compareDesktopReasoningSessions(left: DesktopReasoningSession, right: DesktopReasoningSession): number {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
  const rightTime = Date.parse(right.updatedAt || right.createdAt || "");
  return (Number.isFinite(rightTime) ? rightTime : -1) - (Number.isFinite(leftTime) ? leftTime : -1);
}

function isPromptOnlyDesktopMessage(message: DesktopRoomMessage): boolean {
  return message.agentPromptKind === "auto" && !message.text.trim();
}

function compareDesktopRoomMessages(left: DesktopRoomMessage, right: DesktopRoomMessage): number {
  const leftNumber = desktopMessageNumber(left.id);
  const rightNumber = desktopMessageNumber(right.id);
  if (leftNumber && rightNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
  const leftTime = Date.parse(left.timestamp || "");
  const rightTime = Date.parse(right.timestamp || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (leftNumber && !rightNumber) return -1;
  if (!leftNumber && rightNumber) return 1;
  return left.id.localeCompare(right.id);
}

function desktopMessageNumber(messageId: string): number {
  return Number(/^msg_(\d+)$/.exec(messageId)?.[1] || 0);
}
