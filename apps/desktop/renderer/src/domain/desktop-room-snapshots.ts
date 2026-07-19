import type {
  DesktopGitHubEventsPage,
  DesktopGitHubRoomEvent,
  DesktopReasoningSession,
  DesktopRoomLiveMetadata,
  DesktopRoomMessage,
  DesktopRoomSharedArtifact,
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

export function upsertSnapshotRoomArtifact(
  snapshot: DesktopRoomSnapshot | null,
  artifact: DesktopRoomSharedArtifact,
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  const existingIndex = snapshot.roomArtifacts.findIndex((existing) =>
    existing.identityKey === artifact.identityKey
  );
  const roomArtifacts = [...snapshot.roomArtifacts];
  if (existingIndex >= 0) {
    roomArtifacts.splice(existingIndex, 1, { ...roomArtifacts[existingIndex], ...artifact });
  } else {
    roomArtifacts.unshift(artifact);
  }
  roomArtifacts.sort(compareDesktopRoomArtifacts);
  return {
    ...snapshot,
    roomArtifacts,
  };
}

/**
 * Replace the snapshot's artifacts wholesale with a freshly refetched list.
 * Used by the artifacts-only refetch that reconciles after an `artifact_update`
 * frame (which carries only an identity-key pointer, so it cannot be applied on
 * its own). Keeps the same ordering as the full snapshot's artifacts.
 */
export function replaceSnapshotRoomArtifacts(
  snapshot: DesktopRoomSnapshot | null,
  artifacts: readonly DesktopRoomSharedArtifact[],
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    roomArtifacts: [...artifacts].sort(compareDesktopRoomArtifacts),
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
  return preserveErroredSnapshotSources(current, {
    ...incoming,
    messages: mergeDesktopRoomMessages(current.messages || [], incoming.messages || []),
    githubEvents: mergeDesktopGitHubEventsPage(current.githubEvents, incoming.githubEvents),
  });
}

/**
 * When a refreshed snapshot reports a source as failed (`sourceStates[k].status
 * === "error"`), keep the previously loaded data for that source instead of
 * letting the fetch's empty fallback clobber it — so a transient outage does
 * not blank the room. Messages and GitHub events are already unioned upstream,
 * so they are left untouched here. A source that recovers to "ready" is
 * replaced normally. `incoming.sourceStates` is preserved verbatim so the UI
 * still knows which sources are currently degraded.
 */
export function preserveErroredSnapshotSources(
  current: DesktopRoomSnapshot,
  incoming: DesktopRoomSnapshot,
): DesktopRoomSnapshot {
  const states = incoming.sourceStates;
  if (!states) return incoming;
  const errored = (key: keyof typeof states): boolean => states[key]?.status === "error";
  return {
    ...incoming,
    tasks: errored("tasks") ? current.tasks : incoming.tasks,
    focusRooms: errored("focusRooms") ? current.focusRooms : incoming.focusRooms,
    participants: errored("participants") ? current.participants : incoming.participants,
    participantHiddenCount: errored("participants")
      ? current.participantHiddenCount
      : incoming.participantHiddenCount,
    presence: errored("presence") ? current.presence : incoming.presence,
    reasoningSessions: errored("reasoning") ? current.reasoningSessions : incoming.reasoningSessions,
    recentActivity: errored("activityHistory") ? current.recentActivity : incoming.recentActivity,
    roomArtifacts: errored("roomArtifacts") ? current.roomArtifacts : incoming.roomArtifacts,
    boardSettings: errored("boardSettings") ? current.boardSettings : incoming.boardSettings,
  };
}

/**
 * Apply poll-only room metadata (focus rooms, participants, presence, recent
 * activity, board settings) onto the current snapshot. This is what the
 * periodic 15s tick applies: it replaces ONLY those five sections and leaves
 * every event-fed section — messages, tasks, GitHub events, artifacts,
 * reasoning — untouched, so live-appended data is never clobbered by a poll.
 *
 * A section whose fetch failed (`metadata.sourceStates[k].status === "error"`)
 * keeps the snapshot's previously loaded data — matching
 * `preserveErroredSnapshotSources` — so a transient outage does not blank the
 * room; its error state is still recorded so degraded-state banners show. The
 * sourceStates of the skipped event-fed sections are preserved verbatim.
 */
export function applyRoomLiveMetadata(
  snapshot: DesktopRoomSnapshot | null,
  metadata: DesktopRoomLiveMetadata,
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  if (!snapshotMatchesRoom(snapshot, metadata.roomIdentifier)) return snapshot;
  const states = metadata.sourceStates;
  const errored = (key: keyof typeof states): boolean => states[key]?.status === "error";
  return {
    ...snapshot,
    focusRooms: errored("focusRooms") ? snapshot.focusRooms : metadata.focusRooms,
    participants: errored("participants") ? snapshot.participants : metadata.participants,
    participantHiddenCount: errored("participants")
      ? snapshot.participantHiddenCount
      : metadata.participantHiddenCount,
    presence: errored("presence") ? snapshot.presence : metadata.presence,
    recentActivity: errored("activityHistory") ? snapshot.recentActivity : metadata.recentActivity,
    boardSettings: errored("boardSettings") ? snapshot.boardSettings : metadata.boardSettings,
    sourceStates: {
      ...snapshot.sourceStates,
      focusRooms: states.focusRooms,
      participants: states.participants,
      presence: states.presence,
      activityHistory: states.activityHistory,
      boardSettings: states.boardSettings,
    },
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

/**
 * Live SSE message frames already carry the full message payload, so an
 * appended message renders on its own — with one exception: a message that
 * references a thread root or reply-to that is NOT in the loaded window cannot
 * show its ancestor context. Only that case warrants a snapshot refresh (whose
 * thread-expansion pages backfill the missing ancestors). A message's own id
 * counts as present because it is being appended alongside this check.
 */
export function messageReferencesMissingThreadContext(
  message: DesktopRoomMessage,
  messages: readonly DesktopRoomMessage[],
): boolean {
  const presentIds = new Set<string>();
  for (const existing of messages) presentIds.add(existing.id);
  presentIds.add(message.id);
  const references = [
    message.threadRootId,
    message.threadReplyToId,
    message.replyTo?.id,
    message.thread?.rootMessageId,
  ];
  return references.some(
    (reference) => typeof reference === "string" && reference.length > 0 && !presentIds.has(reference),
  );
}

function compareDesktopGitHubEvents(left: DesktopGitHubRoomEvent, right: DesktopGitHubRoomEvent): number {
  const leftTime = Date.parse(left.createdAt || "");
  const rightTime = Date.parse(right.createdAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.id.localeCompare(left.id);
}

function compareDesktopRoomArtifacts(left: DesktopRoomSharedArtifact, right: DesktopRoomSharedArtifact): number {
  const leftTime = Date.parse(left.updatedAt || left.firstSeenAt || "");
  const rightTime = Date.parse(right.updatedAt || right.firstSeenAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return left.identityKey.localeCompare(right.identityKey);
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
