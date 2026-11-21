import type {
  DesktopGitHubEventsPage,
  DesktopGitHubRoomEvent,
  DesktopReasoningSession,
  DesktopRoomLiveMetadata,
  DesktopRoomMessage,
  DesktopRoomLiveMetadataSourceKey,
  DesktopRoomSharedArtifact,
  DesktopRoomSnapshot,
  DesktopSnapshotSourceKey,
  DesktopTaskSummary,
} from "../../../electron/ipc-types";
import { toRaw } from "vue";
import { normalizeRoomIdentifier } from "./sidebar-rooms";
import { reuseUnchanged } from "./reuse-unchanged";

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

/**
 * The newest shared turn of an agent. A room holds at most one per agent, so
 * a session for the same agent replaces the one shown before.
 */
export function upsertSnapshotLiveActivitySession(
  snapshot: DesktopRoomSnapshot | null,
  session: DesktopReasoningSession
): DesktopRoomSnapshot | null {
  if (!snapshot || session.kind !== "live") return snapshot;
  const agentKey = session.agentKey?.trim() || null;
  const kept = (snapshot.liveActivitySessions ?? []).filter((existing) =>
    existing.id !== session.id && (!agentKey || existing.agentKey?.trim() !== agentKey));
  return { ...snapshot, liveActivitySessions: [session, ...kept] };
}

export function removeSnapshotLiveActivitySession(
  snapshot: DesktopRoomSnapshot | null,
  sessionId: string
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    liveActivitySessions: (snapshot.liveActivitySessions ?? []).filter((session) => session.id !== sessionId),
  };
}

let liveMessageArrival = 0;

export function appendSnapshotMessage(
  snapshot: DesktopRoomSnapshot | null,
  message: DesktopRoomMessage,
  admitParticipation = false,
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  // Only this live-event / successful-send path marks new participation.
  // Snapshot reconciliation and historical batch merges deliberately do not.
  const live = admitParticipation && !message.outgoing && !snapshot.messages.some(existing => existing.id === message.id)
    ? { ...message, liveArrival: ++liveMessageArrival } : message;
  return {
    ...snapshot,
    messages: appendDesktopRoomMessage(snapshot.messages || [], live),
  };
}

// Appends a single message, taking a fast path for the overwhelmingly common
// case: a brand-new message that already belongs at the END of the current
// (already-sorted) list. That case skips the Map rebuild + full O(n log n)
// re-sort that `mergeDesktopRoomMessages` performs on every incoming event.
//
// The fast path MUST be byte-identical to the slow path for the cases it
// handles. It relies on the invariant that `current` is already sorted by
// `compareDesktopRoomMessages` and free of duplicate ids (guaranteed because
// every stored message list is itself the output of a prior merge). Any case
// the fast path can't prove safe — prompt-only filtering, a duplicate id
// (SSE + fallback-poll can deliver the same id twice), or an out-of-order
// arrival — falls back to the unchanged slow path.
export function appendDesktopRoomMessage(
  current: readonly DesktopRoomMessage[],
  message: DesktopRoomMessage
): DesktopRoomMessage[] {
  if (!isPromptOnlyDesktopMessage(message) && canFastAppendDesktopRoomMessage(current, message)) {
    return [...current, message];
  }
  return mergeDesktopRoomMessages(current, [message]);
}

function canFastAppendDesktopRoomMessage(
  current: readonly DesktopRoomMessage[],
  message: DesktopRoomMessage
): boolean {
  // Reject out-of-order arrivals: the message must sort at or after the last
  // element so that appending preserves the sorted invariant.
  const last = current[current.length - 1];
  if (last && compareDesktopRoomMessages(message, last) < 0) return false;
  // Reject a duplicate id so a message delivered twice routes to the slow path
  // (which replaces in place) instead of double-appending.
  for (const existing of current) {
    if (existing.id === message.id) return false;
  }
  return true;
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
  if (["ROOM_DELETED", "ROOM_NOT_FOUND"].includes(incoming.access.code ?? "")) return incoming;
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

/** Every snapshot source, for a placeholder that has read none of them. */
export const ALL_SNAPSHOT_SOURCES: readonly DesktopSnapshotSourceKey[] = [
  "focusRooms",
  "tasks",
  "participants",
  "presence",
  "reasoning",
  "activityHistory",
  "roomArtifacts",
  "boardSettings",
  "messages",
  "githubEvents",
];

/** The snapshot fields that the read of each source fills. */
const SNAPSHOT_SOURCE_FIELDS: Record<DesktopSnapshotSourceKey, readonly (keyof DesktopRoomSnapshot)[]> = {
  focusRooms: ["focusRooms"],
  tasks: ["tasks"],
  participants: ["participants", "participantHiddenCount"],
  presence: ["presence"],
  reasoning: ["reasoningSessions", "liveActivitySessions"],
  activityHistory: ["recentActivity"],
  roomArtifacts: ["roomArtifacts"],
  boardSettings: ["boardSettings"],
  messages: ["messages"],
  githubEvents: ["githubEvents"],
};

/** Whether every source of this snapshot was read: it may give its sections to a later partial read. */
export function isCompleteRoomSnapshot(snapshot: DesktopRoomSnapshot | null): snapshot is DesktopRoomSnapshot {
  return Boolean(snapshot && snapshot.access.status === "ready" && !snapshot.unloadedSources?.length);
}

/**
 * Whether the snapshot on screen can stand in for a kept copy of the same
 * room: it is ready, every source of it was read, and it is the same room in
 * the same storage. Stream events and gap reads change only the snapshot on
 * screen, so such a snapshot is never older than the copy.
 */
export function snapshotCoversRoomCopy(
  shown: DesktopRoomSnapshot | null,
  copy: DesktopRoomSnapshot,
): shown is DesktopRoomSnapshot {
  return isCompleteRoomSnapshot(shown)
    && copy.access.status === "ready"
    && roomSnapshotsMatch(shown, copy)
    && snapshotStorageNamespacesMatch(shown, copy);
}

/**
 * Complete a read that left sources out (`incoming.unloadedSources`, as a read
 * after a stream gap does) from the snapshot on screen: each section it did not
 * read keeps the value and the source state that `current` has. The result is
 * a complete snapshot.
 *
 * When `current` cannot give those sections (another room, not ready, or not
 * complete itself), the read comes back unchanged and still names what it
 * lacks, so the caller can ask for a full read.
 */
export function completeRoomSnapshot(
  current: DesktopRoomSnapshot | null,
  incoming: DesktopRoomSnapshot,
): DesktopRoomSnapshot {
  const unloaded = incoming.unloadedSources;
  if (!unloaded?.length) return incoming;
  if (
    incoming.access.status !== "ready"
    || !isCompleteRoomSnapshot(current)
    || !roomSnapshotsMatch(current, incoming)
    || !snapshotStorageNamespacesMatch(current, incoming)
  ) return incoming;
  const shown = toRaw(current);
  const { unloadedSources: _left, ...read } = incoming;
  const completed: DesktopRoomSnapshot = { ...read };
  // A snapshot without source states (an older main process) stays without them.
  const sourceStates = incoming.sourceStates ? { ...incoming.sourceStates } : null;
  const assign = <K extends keyof DesktopRoomSnapshot>(field: K) => { completed[field] = shown[field]; };
  for (const source of unloaded) {
    for (const field of SNAPSHOT_SOURCE_FIELDS[source] ?? []) assign(field);
    if (sourceStates && shown.sourceStates?.[source]) sourceStates[source] = shown.sourceStates[source];
  }
  if (sourceStates) completed.sourceStates = sourceStates;
  return completed;
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
 *
 * `requested` names the sources the read asked for (absent: all five). A
 * section that was not requested came back as an empty placeholder: the
 * snapshot keeps its own data and source state for it.
 */
export function applyRoomLiveMetadata(
  snapshot: DesktopRoomSnapshot | null,
  metadata: DesktopRoomLiveMetadata,
  requested?: readonly DesktopRoomLiveMetadataSourceKey[],
): DesktopRoomSnapshot | null {
  if (!snapshot) return snapshot;
  if (!snapshotMatchesRoom(snapshot, metadata.roomIdentifier)) return snapshot;
  const states = metadata.sourceStates;
  const kept = (key: keyof typeof states): boolean => Boolean(requested && !requested.includes(key));
  // A failed section and a section that was not requested both keep what the snapshot has.
  const errored = (key: keyof typeof states): boolean => kept(key) || states[key]?.status === "error";
  // Unwrap the top-level Vue proxy. Nested sections read from it are then raw
  // objects, so reused sections stay plain data in the new snapshot.
  const current = toRaw(snapshot);
  // Sections equal to what the snapshot already holds keep their old reference,
  // so a tick that changed nothing changes no reference at all.
  const focusRooms = errored("focusRooms") ? current.focusRooms : reuseUnchanged(current.focusRooms, metadata.focusRooms);
  const participants = errored("participants")
    ? current.participants
    : reuseUnchanged(current.participants, metadata.participants);
  const participantHiddenCount = errored("participants")
    ? current.participantHiddenCount
    : metadata.participantHiddenCount;
  const presence = errored("presence") ? current.presence : reuseUnchanged(current.presence, metadata.presence);
  const recentActivity = errored("activityHistory")
    ? current.recentActivity
    : reuseUnchanged(current.recentActivity, metadata.recentActivity);
  const boardSettings = errored("boardSettings")
    ? current.boardSettings
    : reuseUnchanged(current.boardSettings, metadata.boardSettings);
  const state = (key: keyof typeof states) => (kept(key) ? current.sourceStates?.[key] ?? states[key] : states[key]);
  const sourceStates = reuseUnchanged(current.sourceStates, {
    ...current.sourceStates,
    focusRooms: state("focusRooms"),
    participants: state("participants"),
    presence: state("presence"),
    activityHistory: state("activityHistory"),
    boardSettings: state("boardSettings"),
  });
  if (
    focusRooms === current.focusRooms
    && participants === current.participants
    && participantHiddenCount === current.participantHiddenCount
    && presence === current.presence
    && recentActivity === current.recentActivity
    && boardSettings === current.boardSettings
    && sourceStates === current.sourceStates
  ) return snapshot;
  return {
    ...current,
    focusRooms,
    participants,
    participantHiddenCount,
    presence,
    recentActivity,
    boardSettings,
    sourceStates,
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
      const arrival = byId.get(message.id)?.liveArrival;
      byId.set(message.id, arrival === undefined ? message : { ...message, liveArrival: arrival });
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
  const leftTime = Date.parse(left.eventOrderAt || left.createdAt || "");
  const rightTime = Date.parse(right.eventOrderAt || right.createdAt || "");
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
