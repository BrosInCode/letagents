import type {
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

export function mergeRoomSnapshotMessages(
  current: DesktopRoomSnapshot | null,
  incoming: DesktopRoomSnapshot
): DesktopRoomSnapshot {
  if (!current || !roomSnapshotsMatch(current, incoming)) return incoming;
  if (shouldPreserveCurrentRoomSnapshot(current, incoming)) {
    return {
      ...current,
      messages: mergeDesktopRoomMessages(current.messages || [], incoming.messages || []),
    };
  }
  return {
    ...incoming,
    messages: mergeDesktopRoomMessages(current.messages || [], incoming.messages || []),
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

export function shouldRefreshMetadataForMessage(message: DesktopRoomMessage): boolean {
  const source = (message.source || "").toLowerCase();
  const sender = (message.sender || "").toLowerCase();
  return source === "agent" || source === "browser" || source === "github" || sender === "letagents" || sender === "github";
}

function shouldPreserveCurrentRoomSnapshot(
  current: DesktopRoomSnapshot,
  incoming: DesktopRoomSnapshot
): boolean {
  if (current.access.status !== "ready" || incoming.access.status !== "unavailable") return false;
  const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
  return incoming.access.httpStatus === null || transientStatuses.has(incoming.access.httpStatus);
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
