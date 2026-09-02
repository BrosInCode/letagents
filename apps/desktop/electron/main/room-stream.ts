import type {
  DesktopManagedAgentSession,
  DesktopRentalActivityEvent,
  DesktopRoomDeliveryRepair,
  DesktopRoomMessage,
  DesktopRoomStreamEvent,
  DesktopTaskSummary,
} from "../ipc-types.js";
import { mapApiActivityEvent } from "../rental/api-mapper.js";
import { apiUrl, roomMessageHistoryPageSize } from "./paths.js";
import { readStoredAuth } from "./auth.js";
import { isDesktopSmokeCheck } from "./smoke.js";
import {
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "./rooms/local-store.js";
import {
  getLocalChatMessages,
  getLocalChatRoomWriteSequenceValue,
  getLocalChatThreadRoutingAgentKeysForRoots,
} from "./rooms/messages/local-store.js";
import { subscribeToLocalChatMessageWrites } from "./rooms/messages/local-write-notifications.js";
import { resolveLocalThreadReaderKey } from "./rooms/messages/thread-reader.js";
import {
  mapDesktopReasoningSessionPayload,
  mapDesktopReasoningUpdatePayload,
  mapGitHubRoomEventPayload,
  mapDesktopTaskSummaryPayload,
  mapCloudRoomMessagePayload,
  mapRoomMessagePayload,
} from "./rooms.js";
import { mapRoomArtifactPayload } from "./rooms/snapshot/mappers.js";
import { emitToMainWindow } from "./window.js";
import {
  dispatchRoomStreamEventToManagedAgents,
  listDesktopManagedAgentSessionPopulationForRoom,
} from "./agents/codex-supervisor.js";
import {
  readAgentLocalStateSnapshot,
  type StoredAgentSessionState,
} from "./agents/state.js";
import type { LocalRoutingAuthorityWorker } from "./agents/codex-event-routing.js";
import {
  createManagedMessageDeliveryTracker,
  type ManagedMessageDeliveryTracker,
} from "./room-stream-dedupe.js";

let activeRoomStream: {
  roomIdentifier: string;
  canonicalRoomIdentifier: string | null;
  abortController: AbortController;
  reconnectTimer: NodeJS.Timeout | null;
  pollAbortController: AbortController | null;
  retryMs: number;
  lastMessageId: string | null;
  lastEventCursor: string | null;
  localRoomIdentifier: string | null;
  managedMessageDeliveryTracker: ManagedMessageDeliveryTracker;
  managedTaskDeliveryTracker: ManagedMessageDeliveryTracker;
  localUiMessageTracker: ManagedMessageDeliveryTracker;
  localWriteNotificationGeneration: number;
  localWriteWake: (() => void) | null;
  messageRepairRequestedGeneration: number;
  messageRepairCompletedGeneration: number;
  messageRepairPromise: Promise<void> | null;
  // Large catch-up suppresses intermediate renderer pages and finishes with
  // one authoritative latest window. Keep this durable for the stream
  // generation so a failed final window cannot be forgotten after the
  // managed-delivery cursor has already advanced.
  rendererWindowRefreshNeeded: boolean;
  gapRepairGeneration: number;
  pendingGapRepair: {
    token: number;
    cursorPresent: boolean;
    cursor: string | null;
    messagesRepaired: boolean;
    snapshotRepaired: boolean;
  } | null;
  stopped: boolean;
  // Cloud rooms deliver live messages over SSE. The HTTP long-poll is a
  // *fallback* transport that only runs while SSE is disconnected; `pollActive`
  // is the single flag that keeps that loop alive and lets the SSE-open path
  // retire it. See `openDesktopRoomStream` for the full lifecycle.
  pollActive: boolean;
  // One-shot timer that re-runs a failed SSE-open catch-up while SSE is healthy
  // but the fallback poll is still up, so a single failed catch-up cannot pin
  // the duplicated-transport state for the rest of the room session.
  catchUpRetryTimer: NodeJS.Timeout | null;
  handshakeTimer: NodeJS.Timeout | null;
  handshakeReceived: boolean;
  readyPromise: Promise<void>;
  resolveReady: (() => void) | null;
  readyTimer: NodeJS.Timeout | null;
  deferSseFrames: boolean;
  bufferedSseFrames: Array<{
    eventName: string;
    data: string;
    eventCursor: string | null;
    bytes: number;
  }>;
  bufferedSseFrameBytes: number;
  bufferedSseFrameOverflow: boolean;
} | null = null;

const roomEventCursors = new Map<string, string>();
const MAX_NATIVE_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_REMEMBERED_ROOM_EVENT_CURSORS = 32;
const MAX_DEFERRED_SSE_FRAMES = 256;
const MAX_DEFERRED_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_CATCH_UP_PAGES_PER_PASS = 4;
const MAX_CATCH_UP_MESSAGES_PER_PASS = 400;
const MAX_CATCH_UP_BYTES_PER_PASS = 2 * 1024 * 1024;
const MAX_CATCH_UP_WORK_MS_PER_PASS = 100;
const LOCAL_WRITE_SEQUENCE_POLL_INITIAL_MS = 250;
const LOCAL_WRITE_SEQUENCE_POLL_MAX_MS = 5_000;

subscribeToLocalChatMessageWrites(({ localRoomIdentifier }) => {
  const stream = activeRoomStream;
  if (
    !stream
    || stream.stopped
    || stream.localRoomIdentifier !== localRoomIdentifier
  ) {
    return;
  }
  stream.localWriteNotificationGeneration += 1;
  stream.localWriteWake?.();
});

function rememberRoomEventCursor(roomIdentifier: string, cursor: string | null): void {
  if (!cursor) return;
  roomEventCursors.delete(roomIdentifier);
  roomEventCursors.set(roomIdentifier, cursor);
  while (roomEventCursors.size > MAX_REMEMBERED_ROOM_EVENT_CURSORS) {
    const oldest = roomEventCursors.keys().next().value as string | undefined;
    if (!oldest) break;
    roomEventCursors.delete(oldest);
  }
  if (activeRoomStream?.roomIdentifier === roomIdentifier) {
    activeRoomStream.lastEventCursor = cursor;
  }
}

function clearRoomEventCursor(roomIdentifier: string): void {
  roomEventCursors.delete(roomIdentifier);
  if (activeRoomStream?.roomIdentifier === roomIdentifier) {
    activeRoomStream.lastEventCursor = null;
  }
}

function stageOrApplyRoomEventCursor(
  roomIdentifier: string,
  cursorPresent: boolean,
  cursor: string | null,
): void {
  if (!cursorPresent) return;
  const stream = activeRoomStream;
  if (stream?.roomIdentifier === roomIdentifier && stream.pendingGapRepair) {
    // Keep advancing the staged boundary while the authoritative message and
    // task repair runs. Committing any later live cursor first would make a
    // reconnect skip the still-unrepaired broker gap.
    stream.pendingGapRepair.cursorPresent = true;
    stream.pendingGapRepair.cursor = cursor;
    return;
  }
  if (cursor) rememberRoomEventCursor(roomIdentifier, cursor);
  else clearRoomEventCursor(roomIdentifier);
}

// Retry cadence for a failed SSE-open catch-up (see `openDesktopRoomStream`).
// Read once at module evaluation, like `apiUrl`; the env override exists so
// tests can exercise the retry path without waiting out the real cadence.
const catchUpRetryDelayMs =
  Number(process.env.LETAGENTS_ROOM_STREAM_CATCHUP_RETRY_MS) > 0
    ? Number(process.env.LETAGENTS_ROOM_STREAM_CATCHUP_RETRY_MS)
    : 20_000;
const roomSyncHandshakeTimeoutMs =
  Number(process.env.LETAGENTS_ROOM_SYNC_HANDSHAKE_TIMEOUT_MS) > 0
    ? Number(process.env.LETAGENTS_ROOM_SYNC_HANDSHAKE_TIMEOUT_MS)
    : 4_000;

export function getActiveRoomIdentifier(): string | null {
  return activeRoomStream?.roomIdentifier ?? null;
}

function isCurrentRoomStream(
  stream: NonNullable<typeof activeRoomStream>,
): boolean {
  return activeRoomStream === stream && !stream.stopped;
}

export function emitRoomStreamEvent(
  event: DesktopRoomStreamEvent,
  options: { deliverToManagedAgents?: boolean } = {},
): void {
  emitToMainWindow("desktop:room:stream-event", event);
  if (options.deliverToManagedAgents === false) {
    return;
  }
  try {
    managedAgentRoomStreamDispatcher(event);
  } catch {
    // Agent delivery must not break the human room stream.
  }
}

export async function deliverDesktopRoomMessageToManagedAgents(
  roomIdentifier: string,
  message: DesktopRoomMessage,
): Promise<void> {
  await deliverDesktopRoomMessageToManagedAgentsInternal(roomIdentifier, message, true);
}

async function deliverDesktopRoomMessageToManagedAgentsInternal(
  roomIdentifier: string,
  message: DesktopRoomMessage,
  scheduleRetry: boolean,
): Promise<"ready" | "transient" | "invalid"> {
  let deliveryMessage = message;
  let transientHydrationFailure = false;
  if (!message.accountAgentRouting) {
    try {
      const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
      if (storage.effectiveMode === "local") {
        const [routed] = await localAccountAgentRoutingHydrator(
          roomIdentifier,
          localRoomIdentifierForStorage(storage, roomIdentifier),
          [message],
        );
        deliveryMessage = routed ?? message;
      }
    } catch {
      transientHydrationFailure = true;
      deliveryMessage = {
        ...message,
        accountAgentRouting: { version: 1, authority: "invalid" },
      };
    }
  }
  if (deliveryMessage.accountAgentRouting?.authority === "invalid") {
    // A missing envelope that could not be projected is retryable. An
    // explicitly invalid imported/server envelope is durable authority and
    // must remain fail-closed instead of being reinterpreted as legacy data.
    if (transientHydrationFailure) {
      if (scheduleRetry) scheduleLocalManagedMessageDeliveryRetry(roomIdentifier, message);
      return "transient";
    }
    return "invalid";
  }
  removePendingLocalManagedMessageDelivery(roomIdentifier, message.id);
  const shouldDeliverToManagedAgents = shouldDeliverManagedMessageEvent(roomIdentifier, message.id);
  if (!shouldDeliverToManagedAgents) return "ready";
  managedAgentRoomStreamDispatcher({
    type: "message",
    roomIdentifier,
    message: deliveryMessage ?? message,
  });
  return "ready";
}

type LocalManagedMessageDeliveryRetry = {
  messages: Map<string, DesktopRoomMessage>;
  attempt: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const MAX_LOCAL_MANAGED_DELIVERY_RETRY_MESSAGES = 500;
const MAX_LOCAL_MANAGED_DELIVERY_RETRY_ATTEMPTS = 8;
const MAX_LOCAL_MANAGED_DELIVERY_RETRY_AGE_MS = 30_000;
const localManagedMessageDeliveryRetries = new Map<string, LocalManagedMessageDeliveryRetry>();

function removePendingLocalManagedMessageDelivery(
  roomIdentifier: string,
  messageId: string,
): void {
  const roomKey = roomIdentifier.trim();
  const pending = localManagedMessageDeliveryRetries.get(roomKey);
  if (!pending) return;
  pending.messages.delete(messageId);
  if (pending.messages.size > 0) return;
  if (pending.timer) clearTimeout(pending.timer);
  localManagedMessageDeliveryRetries.delete(roomKey);
}

function clearLocalManagedMessageDeliveryRetries(roomIdentifier?: string): void {
  const roomKey = roomIdentifier?.trim();
  for (const [key, pending] of localManagedMessageDeliveryRetries) {
    if (roomKey && key !== roomKey) continue;
    if (pending.timer) clearTimeout(pending.timer);
    localManagedMessageDeliveryRetries.delete(key);
  }
}

export function inspectLocalManagedMessageDeliveryRetriesForTest(): {
  rooms: number;
  messages: number;
} {
  return {
    rooms: localManagedMessageDeliveryRetries.size,
    messages: [...localManagedMessageDeliveryRetries.values()]
      .reduce((total, pending) => total + pending.messages.size, 0),
  };
}

export function clearLocalManagedMessageDeliveryRetriesForTest(): void {
  clearLocalManagedMessageDeliveryRetries();
}

function scheduleLocalManagedMessageDeliveryRetry(
  roomIdentifier: string,
  message: DesktopRoomMessage,
): void {
  const roomKey = roomIdentifier.trim();
  let pending = localManagedMessageDeliveryRetries.get(roomKey);
  if (!pending) {
    pending = { messages: new Map(), attempt: 0, startedAt: Date.now(), timer: null };
    localManagedMessageDeliveryRetries.set(roomKey, pending);
  }
  // The ordered local poll remains the durable recovery owner. This small
  // coalesced queue only closes the immediate-send latency gap; overflow is
  // intentionally left for the poll rather than spawning per-message timers.
  if (
    pending.messages.size < MAX_LOCAL_MANAGED_DELIVERY_RETRY_MESSAGES
    || pending.messages.has(message.id)
  ) {
    pending.messages.set(message.id, message);
  }
  scheduleLocalManagedMessageDeliveryRetryTimer(roomKey, pending);
}

function scheduleLocalManagedMessageDeliveryRetryTimer(
  roomIdentifier: string,
  pending: LocalManagedMessageDeliveryRetry,
): void {
  if (pending.timer || pending.messages.size === 0) return;
  if (
    pending.attempt >= MAX_LOCAL_MANAGED_DELIVERY_RETRY_ATTEMPTS
    || Date.now() - pending.startedAt >= MAX_LOCAL_MANAGED_DELIVERY_RETRY_AGE_MS
  ) {
    localManagedMessageDeliveryRetries.delete(roomIdentifier);
    return;
  }
  const delayMs = Math.min(2_000, 50 * (2 ** Math.min(pending.attempt + 1, 5)));
  pending.timer = setTimeout(() => {
    pending.timer = null;
    void retryLocalManagedMessageDeliveries(roomIdentifier, pending);
  }, delayMs);
  pending.timer.unref?.();
}

async function retryLocalManagedMessageDeliveries(
  roomIdentifier: string,
  pending: LocalManagedMessageDeliveryRetry,
): Promise<void> {
  if (localManagedMessageDeliveryRetries.get(roomIdentifier) !== pending) return;
  if (
    activeRoomStream
    && (activeRoomStream.stopped || activeRoomStream.roomIdentifier !== roomIdentifier)
  ) {
    clearLocalManagedMessageDeliveryRetries(roomIdentifier);
    return;
  }
  pending.attempt += 1;
  for (const [messageId, message] of pending.messages) {
    let result: "ready" | "transient" | "invalid";
    try {
      result = await deliverDesktopRoomMessageToManagedAgentsInternal(
        roomIdentifier,
        message,
        false,
      );
    } catch {
      result = "transient";
    }
    if (result === "transient") break;
    pending.messages.delete(messageId);
  }
  if (pending.messages.size === 0) {
    localManagedMessageDeliveryRetries.delete(roomIdentifier);
    return;
  }
  scheduleLocalManagedMessageDeliveryRetryTimer(roomIdentifier, pending);
}

function isPersistedWorkerActiveInRoom(
  session: StoredAgentSessionState,
  roomIdentifiers: ReadonlySet<string>,
): boolean {
  return session.session_kind === "worker"
    && !session.ended_at
    && roomIdentifiers.has(String(session.room_id ?? "").trim())
    && Boolean(String(session.session_id ?? "").trim())
    && Boolean(String(session.agent_key ?? "").trim());
}

function localRoutingAuthorityPopulation(
  roomIdentifier: string,
  localRoomIdentifier: string,
  desktopSessions: readonly DesktopManagedAgentSession[],
): { complete: boolean; sessions: LocalRoutingAuthorityWorker[] } {
  const snapshot = readAgentLocalStateSnapshot();
  const roomIdentifiers = new Set(
    [roomIdentifier, localRoomIdentifier].map((value) => value.trim()).filter(Boolean),
  );
  const sessions = new Map<string, LocalRoutingAuthorityWorker>();
  for (const session of desktopSessions) {
    const sessionId = String(session.agentSessionId ?? "").trim();
    if (sessionId) sessions.set(sessionId, session);
  }
  for (const stored of Object.values(snapshot.state.agent_sessions ?? {})) {
    if (!isPersistedWorkerActiveInRoom(stored, roomIdentifiers)) continue;
    const sessionId = stored.session_id.trim();
    if (sessions.has(sessionId)) continue;
    sessions.set(sessionId, {
      id: `persisted:${sessionId}`,
      agentSessionId: sessionId,
      agentKey: stored.agent_key?.trim() || null,
      actorLabel: stored.actor_label?.trim() || null,
      displayName: stored.display_name?.trim() || null,
      startedAt: stored.created_at?.trim() || stored.updated_at?.trim() || "1970-01-01T00:00:00.000Z",
    });
  }
  return { complete: snapshot.complete, sessions: [...sessions.values()] };
}

async function attachLocalAccountAgentRouting(
  roomIdentifier: string,
  localRoomIdentifier: string,
  messages: readonly DesktopRoomMessage[],
): Promise<DesktopRoomMessage[]> {
  const roots = new Set<string>();
  for (const message of messages) {
    const rootId = message.threadRootId || message.thread?.rootMessageId || message.id;
    if (!message.accountAgentRouting && rootId !== message.id) roots.add(rootId);
  }

  try {
    const unresolvedMessages = messages.filter((message) => !message.accountAgentRouting);
    if (unresolvedMessages.length === 0) return [...messages];
    const population = listDesktopManagedAgentSessionPopulationForRoom(roomIdentifier);
    const authorityPopulation = localRoutingAuthorityPopulation(
      roomIdentifier,
      localRoomIdentifier,
      population.sessions,
    );
    if (!population.complete || !authorityPopulation.complete) {
      return messages.map((message) => message.accountAgentRouting
        ? message
        : { ...message, accountAgentRouting: { version: 1, authority: "invalid" } });
    }
    const sessions = population.sessions;
    const { buildLocalLegacyAccountAgentRouting } = await import("./agents/codex-event-routing.js");
    const membership = roots.size > 0
      ? await getLocalChatThreadRoutingAgentKeysForRoots(
          localRoomIdentifier,
          [...roots],
          authorityPopulation.sessions,
        )
      : new Map<string, Set<string>>();
    return messages.map((message) => {
      const rootId = message.threadRootId || message.thread?.rootMessageId || message.id;
      if (message.accountAgentRouting) return message;
      const participantKeys = [...(membership.get(rootId) ?? [])].sort();
      return {
        ...message,
        accountAgentRouting: buildLocalLegacyAccountAgentRouting(
          sessions,
          message,
          participantKeys,
          authorityPopulation.sessions,
        ),
      };
    });
  } catch {
    // A local projection failure must not turn a persisted human message into
    // a failed send or fall back to a capped display approximation.
    return messages.map((message) => {
      return message.accountAgentRouting
        ? message
        : { ...message, accountAgentRouting: { version: 1, authority: "invalid" } };
    });
  }
}

type LocalAccountAgentRoutingHydrator = typeof attachLocalAccountAgentRouting;
let localAccountAgentRoutingHydrator: LocalAccountAgentRoutingHydrator =
  attachLocalAccountAgentRouting;
type LocalMessagePageReader = typeof getLocalChatMessages;
type LocalWriteSequenceReader = typeof getLocalChatRoomWriteSequenceValue;
let localMessagePageReader: LocalMessagePageReader = getLocalChatMessages;
let localWriteSequenceReader: LocalWriteSequenceReader = getLocalChatRoomWriteSequenceValue;
let localWriteWaiterForTest: ((timeoutMs: number) => Promise<boolean>) | null = null;
let localWriteWaitScheduledObserverForTest: ((timeoutMs: number) => void) | null = null;
let localWriteWaitResolvedObserverForTest: ((notified: boolean) => void) | null = null;

type ManagedAgentRoomStreamDispatcher = typeof dispatchRoomStreamEventToManagedAgents;
let managedAgentRoomStreamDispatcher: ManagedAgentRoomStreamDispatcher =
  dispatchRoomStreamEventToManagedAgents;

export function setLocalAccountAgentRoutingHydratorForTest(
  hydrator: LocalAccountAgentRoutingHydrator | null,
): void {
  localAccountAgentRoutingHydrator = hydrator ?? attachLocalAccountAgentRouting;
}

export function setLocalRoomMessagePollDependenciesForTest(dependencies: {
  readMessages?: LocalMessagePageReader;
  readWriteSequence?: LocalWriteSequenceReader;
  wait?: (timeoutMs: number) => Promise<boolean>;
  onWaitScheduled?: (timeoutMs: number) => void;
  onWaitResolved?: (notified: boolean) => void;
} | null): void {
  localMessagePageReader = dependencies?.readMessages ?? getLocalChatMessages;
  localWriteSequenceReader =
    dependencies?.readWriteSequence ?? getLocalChatRoomWriteSequenceValue;
  localWriteWaiterForTest = dependencies?.wait ?? null;
  localWriteWaitScheduledObserverForTest = dependencies?.onWaitScheduled ?? null;
  localWriteWaitResolvedObserverForTest = dependencies?.onWaitResolved ?? null;
}

export function setManagedAgentRoomStreamDispatcherForTest(
  dispatcher: ManagedAgentRoomStreamDispatcher | null,
): void {
  managedAgentRoomStreamDispatcher = dispatcher ?? dispatchRoomStreamEventToManagedAgents;
}

export function emitPersistedLocalRoomArtifactUpdate(
  localRoomIdentifier: string,
  artifactPayload: Parameters<typeof mapRoomArtifactPayload>[0],
): void {
  const stream = activeRoomStream;
  const localIdentifier = localRoomIdentifier.trim();
  if (
    !stream ||
    !localIdentifier ||
    stream.localRoomIdentifier !== localIdentifier ||
    stream.stopped
  ) {
    return;
  }

  const artifact = mapRoomArtifactPayload(artifactPayload);
  if (!artifact) return;
  emitRoomStreamEvent({
    type: "artifact_update",
    roomIdentifier: stream.roomIdentifier,
    artifactIdentityKey: artifact.identityKey,
    artifact,
  }, { deliverToManagedAgents: false });
}

function shouldDeliverManagedMessageEvent(
  roomIdentifier: string,
  messageId: string | null | undefined,
): boolean {
  return activeRoomStream?.managedMessageDeliveryTracker.remember(roomIdentifier, messageId) ?? true;
}

function shouldDeliverManagedTaskEvent(
  roomIdentifier: string,
  task: DesktopTaskSummary,
): boolean {
  return activeRoomStream?.managedTaskDeliveryTracker.remember(
    roomIdentifier,
    `${task.id}@${task.updatedAt}`,
  ) ?? true;
}

/**
 * Replays only deltas found by the renderer's authoritative gap snapshot. The
 * renderer already owns UI reconciliation; this path restores the managed
 * agent delivery that a broker gap could otherwise silently skip.
 */
export function repairDesktopRoomStreamManagedDelivery(
  roomIdentifier: string,
  repair: DesktopRoomDeliveryRepair,
): void {
  const stream = activeRoomStream;
  if (!stream || !isCurrentRoomStream(stream) || stream.roomIdentifier !== roomIdentifier.trim()) return;
  for (const message of repair.messages) {
    if (!shouldDeliverManagedMessageEvent(roomIdentifier, message.id)) continue;
    try {
      dispatchRoomStreamEventToManagedAgents({ type: "message", roomIdentifier, message });
    } catch {
      // A managed runtime must not break later repaired deliveries.
    }
  }
  for (const task of repair.tasks) {
    if (!shouldDeliverManagedTaskEvent(roomIdentifier, task)) continue;
    try {
      dispatchRoomStreamEventToManagedAgents({ type: "task_update", roomIdentifier, task });
    } catch {
      // A managed runtime must not break later repaired deliveries.
    }
  }
  if (stream.pendingGapRepair?.token === repair.token) {
    stream.pendingGapRepair.snapshotRepaired = true;
    commitCompletedGapRepair(stream);
  }
}

function commitCompletedGapRepair(stream: NonNullable<typeof activeRoomStream>): void {
  const repair = stream.pendingGapRepair;
  if (!repair?.messagesRepaired || !repair.snapshotRepaired) return;
  if (repair.cursorPresent) {
    if (repair.cursor) rememberRoomEventCursor(stream.roomIdentifier, repair.cursor);
    else clearRoomEventCursor(stream.roomIdentifier);
  }
  if (stream.pendingGapRepair === repair) stream.pendingGapRepair = null;
}

function mapRoomStreamTaskPayload(task: {
  id?: string;
  title?: string;
  description?: string | null;
  status?: string;
  assignee?: string | null;
  assignee_agent_key?: string | null;
  created_by?: string | null;
  pr_url?: string | null;
  workflow_artifacts?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["workflow_artifacts"];
  workflow_refs?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["workflow_refs"];
  active_leases?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["active_leases"];
  active_locks?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["active_locks"];
  stale_prompt_state?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["stale_prompt_state"];
  created_at?: string | null;
  updated_at?: string;
  updatedAt?: string;
}): DesktopTaskSummary | null {
  if (!task.id) return null;
  return mapDesktopTaskSummaryPayload({ ...task, id: task.id });
}

function readStreamActivity(
  payload: Record<string, unknown>,
): DesktopRentalActivityEvent | null {
  const rawActivity = payload.activity;
  return mapApiActivityEvent(rawActivity ?? payload);
}

function readPatchIdFromActivityPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const obj = payload as Record<string, unknown>;
  return typeof obj.patch_id === "string"
    ? obj.patch_id
    : typeof obj.patchId === "string"
      ? obj.patchId
      : null;
}

function repairMalformedRoomStreamFrame(
  roomIdentifier: string,
  eventCursor: string | null,
): void {
  const stream = activeRoomStream;
  if (!stream || !isCurrentRoomStream(stream) || stream.roomIdentifier !== roomIdentifier) return;
  if (stream.pendingGapRepair) {
    repairDurableMessagesAfterBrokerGap(stream, stream.pendingGapRepair.token);
    return;
  }
  const gapRepairToken = ++stream.gapRepairGeneration;
  stream.pendingGapRepair = {
    token: gapRepairToken,
    // The frame identified by eventCursor was not applied. Repair from the
    // last known-good cursor; never bless the malformed frame as a boundary.
    cursorPresent: false,
    cursor: null,
    messagesRepaired: false,
    snapshotRepaired: false,
  };
  emitRoomStreamEvent({
    type: "open",
    roomIdentifier,
    checkpoint: stream.lastMessageId,
    gap: true,
    verified: true,
    deliveryRepairToken: gapRepairToken,
  }, { deliverToManagedAgents: false });
  repairDurableMessagesAfterBrokerGap(stream, gapRepairToken);
}

function handleRoomStreamFrame(
  roomIdentifier: string,
  eventName: string,
  data: string,
  eventCursor: string | null,
): void {
  if (!data.trim()) {
    repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
    return;
  }

  const eventRoomIdentifier =
    typeof payload.room_id === "string" ? payload.room_id : roomIdentifier;
  if (eventName === "task_update") {
    const task = mapRoomStreamTaskPayload(payload);
    if (task) {
      stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
      emitRoomStreamEvent({
        type: "task_update",
        roomIdentifier: eventRoomIdentifier,
        task,
      }, { deliverToManagedAgents: shouldDeliverManagedTaskEvent(eventRoomIdentifier, task) });
    } else repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
    return;
  }

  if (eventName === "room_sync") {
    const cursorPresent = Object.prototype.hasOwnProperty.call(payload, "event_cursor")
      || eventCursor !== null;
    const syncCursor = typeof payload.event_cursor === "string"
      ? payload.event_cursor
      : payload.event_cursor === null
        ? null
        : eventCursor;
    const gapRepairToken = payload.gap === true && activeRoomStream?.roomIdentifier === roomIdentifier
      ? ++activeRoomStream.gapRepairGeneration
      : null;
    if (gapRepairToken === null && cursorPresent) {
      stageOrApplyRoomEventCursor(roomIdentifier, true, syncCursor);
    }
    if (activeRoomStream?.roomIdentifier === roomIdentifier) {
      if (isValidStreamRoomIdentifier(payload.room_id)) {
        activeRoomStream.canonicalRoomIdentifier = payload.room_id;
      }
      activeRoomStream.handshakeReceived = true;
      if (activeRoomStream.handshakeTimer) clearTimeout(activeRoomStream.handshakeTimer);
      activeRoomStream.handshakeTimer = null;
      activeRoomStream.resolveReady?.();
      activeRoomStream.resolveReady = null;
      if (activeRoomStream.readyTimer) clearTimeout(activeRoomStream.readyTimer);
      activeRoomStream.readyTimer = null;
    }
    const gapRepairStream = gapRepairToken !== null
      && activeRoomStream?.roomIdentifier === roomIdentifier
      ? activeRoomStream
      : null;
    if (gapRepairStream) {
      const activeGapRepairToken = gapRepairToken as number;
      gapRepairStream.pendingGapRepair = {
        token: activeGapRepairToken,
        cursorPresent,
        cursor: syncCursor,
        messagesRepaired: false,
        snapshotRepaired: false,
      };
    }
    emitRoomStreamEvent({
      type: "open",
      roomIdentifier: eventRoomIdentifier,
      checkpoint: typeof payload.checkpoint === "string" ? payload.checkpoint : null,
      gap: payload.gap === true,
      verified: true,
      deliveryRepairToken: gapRepairToken ?? undefined,
    }, { deliverToManagedAgents: false });
    if (gapRepairStream) {
      repairDurableMessagesAfterBrokerGap(gapRepairStream, gapRepairToken as number);
    }
    return;
  }

  if (eventName === "github_event") {
    const event = mapGitHubRoomEventPayload(payload);
    if (event) {
      stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
      emitRoomStreamEvent({
        type: "github_event",
        roomIdentifier: eventRoomIdentifier,
        event,
      });
    } else repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
    return;
  }

  if (eventName === "artifact_update") {
    const artifact = mapRoomArtifactPayload(
      payload.artifact && typeof payload.artifact === "object"
        ? payload.artifact as Parameters<typeof mapRoomArtifactPayload>[0]
        : null,
    );
    const artifactIdentityKey = typeof payload.artifact_identity_key === "string"
      ? payload.artifact_identity_key
      : artifact?.identityKey ?? null;
    if (!artifact && !artifactIdentityKey) {
      repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
      return;
    }
    stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
    emitRoomStreamEvent({
      type: "artifact_update",
      roomIdentifier: eventRoomIdentifier,
      artifactIdentityKey,
      artifact,
    });
    return;
  }

  if (eventName === "reasoning_update") {
    const session = payload.session;
    if (
      session &&
      typeof session === "object" &&
      typeof (session as { id?: unknown }).id === "string"
    ) {
      stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
      emitRoomStreamEvent({
        type: "reasoning_update",
        roomIdentifier: eventRoomIdentifier,
        session: mapDesktopReasoningSessionPayload(
          session as Parameters<typeof mapDesktopReasoningSessionPayload>[0],
        ),
      });
    } else repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
    return;
  }

  if (eventName === "reasoning_remove") {
    const sessionId =
      typeof payload.session_id === "string"
        ? payload.session_id
        : typeof payload.id === "string"
          ? payload.id
          : null;
    if (sessionId) {
      stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
      emitRoomStreamEvent({
        type: "reasoning_remove",
        roomIdentifier: eventRoomIdentifier,
        sessionId,
      });
    } else repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
    return;
  }

  if (eventName === "rental_activity") {
    const activity = readStreamActivity(payload);
    if (activity) {
      stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
      emitRoomStreamEvent({
        type: "rental_activity",
        roomIdentifier: eventRoomIdentifier,
        activity,
      });
    } else repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
    return;
  }

  if (eventName === "rental_patch") {
    const activity = readStreamActivity(payload);
    if (!activity) {
      repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
      return;
    }
    stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
    emitRoomStreamEvent({
      type: "rental_patch",
      roomIdentifier: eventRoomIdentifier,
      activity,
      patchId: readPatchIdFromActivityPayload(activity?.payload ?? null),
    });
    return;
  }

  if (eventName === "rental_usage") {
    const activity = readStreamActivity(payload);
    if (!activity) {
      repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
      return;
    }
    stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
    emitRoomStreamEvent({
      type: "rental_usage",
      roomIdentifier: eventRoomIdentifier,
      activity,
      sessionId: activity?.sessionId || null,
    });
    return;
  }

  if (eventName === "session_disconnect") {
    stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
    emitRoomStreamEvent({
      type: "session_disconnect",
      roomIdentifier: eventRoomIdentifier,
      message: "Room stream disconnected.",
    });
    return;
  }

  if (eventName === "message_info_updated") {
    if (
      payload.message_ids !== null && (
        !Array.isArray(payload.message_ids)
        || payload.message_ids.some((messageId) => typeof messageId !== "string" || !messageId)
      )
    ) {
      repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
      return;
    }
    // Desktop Message Info is fetched on demand and has no live invalidation
    // surface yet. Null is the server's concealment-safe room invalidation;
    // arrays retain their existing compatibility. Treat both as a valid no-op so
    // it advances the broker cursor without turning every read receipt into a
    // full room gap/snapshot repair. Malformed typed frames still fail closed.
    stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
    return;
  }

  if (eventName === "resource_invalidation_v1") {
    const keys = Object.keys(payload).sort();
    const payloadRoomIdentifier = payload.room_id;
    const resource = payload.resource;
    if (
      keys.length !== 2
      || keys[0] !== "resource"
      || keys[1] !== "room_id"
      || !isValidStreamRoomIdentifier(payloadRoomIdentifier)
      || typeof resource !== "string"
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(resource)
      || payloadRoomIdentifier !== (
        activeRoomStream?.roomIdentifier === roomIdentifier
          ? activeRoomStream.canonicalRoomIdentifier ?? roomIdentifier
          : roomIdentifier
      )
    ) {
      repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
      return;
    }
    stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
    if (resource === "agent_work") {
      emitRoomStreamEvent({
        type: "resource_invalidation",
        roomIdentifier: payloadRoomIdentifier,
        resource,
      }, { deliverToManagedAgents: false });
    }
    return;
  }

  if (eventName === "message") {
    const messageId = typeof payload.id === "string" ? payload.id : null;
    if (!messageId) {
      repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
      return;
    }
    stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
    if (
      activeRoomStream?.roomIdentifier === roomIdentifier &&
      messageId
    ) {
      activeRoomStream.lastMessageId = messageId;
    }
    const shouldDeliverToManagedAgents = shouldDeliverManagedMessageEvent(eventRoomIdentifier, messageId);
    emitRoomStreamEvent({
      type: "message",
      roomIdentifier: eventRoomIdentifier,
      message: mapCloudRoomMessagePayload(
        payload as Parameters<typeof mapRoomMessagePayload>[0],
      ),
    }, { deliverToManagedAgents: shouldDeliverToManagedAgents });
    return;
  }
  // Newer servers may publish event types this client does not render. A
  // bounded, well-formed unknown event is a no-op, not evidence of a gap.
  const bytes = Buffer.byteLength(eventName) + Buffer.byteLength(data)
    + (eventCursor ? Buffer.byteLength(eventCursor) : 0);
  if (bytes > MAX_NATIVE_SSE_FRAME_BYTES) {
    repairMalformedRoomStreamFrame(roomIdentifier, eventCursor);
    return;
  }
  stageOrApplyRoomEventCursor(roomIdentifier, eventCursor !== null, eventCursor);
}

function isValidStreamRoomIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function queueOrHandleRoomStreamFrame(
  stream: NonNullable<typeof activeRoomStream>,
  eventName: string,
  data: string,
  eventCursor: string | null,
): void {
  if (!stream.deferSseFrames) {
    handleRoomStreamFrame(stream.roomIdentifier, eventName, data, eventCursor);
    return;
  }
  if (stream.bufferedSseFrameOverflow) return;
  const bytes = Buffer.byteLength(eventName) + Buffer.byteLength(data)
    + (eventCursor ? Buffer.byteLength(eventCursor) : 0);
  if (
    stream.bufferedSseFrames.length >= MAX_DEFERRED_SSE_FRAMES
    || stream.bufferedSseFrameBytes + bytes > MAX_DEFERRED_SSE_FRAME_BYTES
  ) {
    // Release potentially large payload strings immediately. The durable
    // message cursor plus the renderer snapshot are the authoritative repair.
    stream.bufferedSseFrames = [];
    stream.bufferedSseFrameBytes = 0;
    stream.bufferedSseFrameOverflow = true;
    return;
  }
  stream.bufferedSseFrames.push({ eventName, data, eventCursor, bytes });
  stream.bufferedSseFrameBytes += bytes;
}

function finishDeferredSseFrames(
  stream: NonNullable<typeof activeRoomStream>,
): void {
  stream.deferSseFrames = false;
  const overflowed = stream.bufferedSseFrameOverflow;
  const frames = stream.bufferedSseFrames;
  stream.bufferedSseFrames = [];
  stream.bufferedSseFrameBytes = 0;
  stream.bufferedSseFrameOverflow = false;
  if (!isCurrentRoomStream(stream)) return;
  if (overflowed) {
    handleRoomStreamFrame(
      stream.roomIdentifier,
      "room_sync",
      JSON.stringify({ gap: true, event_cursor: stream.lastEventCursor }),
      stream.lastEventCursor,
    );
    return;
  }
  for (const frame of frames) {
    if (!isCurrentRoomStream(stream)) return;
    handleRoomStreamFrame(
      stream.roomIdentifier,
      frame.eventName,
      frame.data,
      frame.eventCursor,
    );
  }
}

// Perform a single `GET /messages/poll` request and emit whatever messages it
// returns, advancing the cursor. Shared by the fallback long-poll loop
// (`timeoutMs = 25_000`, one request per iteration) and the SSE-open catch-up
// (`timeoutMs = 0`, a single non-blocking gap-fill). Cursor advancement and the
// dedupe/delivery decision are identical in both callers so the two transports
// stay interchangeable and never diverge on what "delivered" means.
async function fetchRoomMessagePollPage(
  stream: NonNullable<typeof activeRoomStream>,
  after: string | null,
  timeoutMs: number,
  signal: AbortSignal,
  options: { emitToRenderer?: boolean; batchRenderer?: boolean } = {},
): Promise<{
  hasMore: boolean;
  lastMessageId: string | null;
  messageCount: number;
  serializedBytes: number;
}> {
  const storedAuth = await readStoredAuth();
  const requestHeaders = new Headers({
    Accept: "application/json",
    "X-LetAgents-Desktop-Client": "1",
  });
  if (storedAuth.token) {
    requestHeaders.set("Authorization", `Bearer ${storedAuth.token}`);
  }
  const params = new URLSearchParams({
    limit: String(roomMessageHistoryPageSize),
    timeout: String(timeoutMs),
  });
  if (after) params.set("after", after);
  const response = await fetch(
    `${apiUrl}/rooms/${encodeURIComponent(stream.roomIdentifier)}/messages/poll?${params.toString()}`,
    { headers: requestHeaders, signal },
  );
  if (!response.ok) {
    throw new Error(`Room poll failed with HTTP ${response.status}.`);
  }
  const page = (await response.json()) as {
    room_id?: string;
    messages?: Parameters<typeof mapRoomMessagePayload>[0][];
    has_more?: boolean;
  };
  if (!isCurrentRoomStream(stream)) {
    return {
      hasMore: false,
      lastMessageId: stream.lastMessageId,
      messageCount: 0,
      serializedBytes: 0,
    };
  }
  let messageCount = 0;
  let serializedBytes = 0;
  const rendererMessages: DesktopRoomMessage[] = [];
  for (const rawMessage of page.messages || []) {
    if (!isCurrentRoomStream(stream)) {
      return { hasMore: false, lastMessageId: stream.lastMessageId, messageCount, serializedBytes };
    }
    if (typeof rawMessage.id === "string") {
      stream.lastMessageId = rawMessage.id;
    }
    const roomIdentifier = page.room_id || stream.roomIdentifier;
    const message = mapCloudRoomMessagePayload(rawMessage);
    messageCount += 1;
    try {
      serializedBytes += Buffer.byteLength(JSON.stringify(rawMessage));
    } catch {
      serializedBytes = MAX_CATCH_UP_BYTES_PER_PASS + 1;
    }
    const shouldDeliver = shouldDeliverManagedMessageEvent(roomIdentifier, rawMessage.id);
    if (options.emitToRenderer === false) {
      if (shouldDeliver) {
        try {
          dispatchRoomStreamEventToManagedAgents({ type: "message", roomIdentifier, message });
        } catch {
          // One managed runtime must not break exact progress for later ids.
        }
      }
      continue;
    }
    if (options.batchRenderer) {
      rendererMessages.push(message);
      if (shouldDeliver) {
        try {
          dispatchRoomStreamEventToManagedAgents({ type: "message", roomIdentifier, message });
        } catch {
          // One managed runtime must not break exact progress for later ids.
        }
      }
      continue;
    }
    emitRoomStreamEvent({
      type: "message",
      roomIdentifier,
      message,
    }, { deliverToManagedAgents: shouldDeliver });
  }
  if (rendererMessages.length > 0) {
    emitRoomStreamEvent({
      type: "message_batch",
      roomIdentifier: page.room_id || stream.roomIdentifier,
      messages: rendererMessages,
    }, { deliverToManagedAgents: false });
  }
  return {
    hasMore: page.has_more === true,
    lastMessageId: stream.lastMessageId,
    messageCount,
    serializedBytes,
  };
}

// Fallback transport: a 25s server-held long-poll re-issued forever, but ONLY
// while `pollActive` is set (i.e. while SSE is disconnected). SSE recovery
// clears `pollActive` and aborts the in-flight request via `stopFallbackPoll`.
async function pollDesktopRoomMessages(
  stream: NonNullable<typeof activeRoomStream>,
): Promise<void> {
  while (isCurrentRoomStream(stream) && stream.pollActive) {
    const after = stream.lastMessageId;
    const pollAbortController = new AbortController();
    stream.pollAbortController = pollAbortController;
    try {
      if (!after) {
        await fetchLatestRoomMessagePage(stream, pollAbortController.signal);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } else {
        await fetchRoomMessagePollPage(stream, after, 25_000, pollAbortController.signal);
      }
    } catch (error) {
      if (
        !isCurrentRoomStream(stream) ||
        !stream.pollActive ||
        pollAbortController.signal.aborted
      )
        return;
      emitRoomStreamEvent({
        type: "error",
        roomIdentifier: stream.roomIdentifier,
        message:
          error instanceof Error ? error.message : "Room polling disconnected.",
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));
    } finally {
      if (stream.pollAbortController === pollAbortController) {
        stream.pollAbortController = null;
      }
    }
  }
}

async function fetchLatestRoomMessagePage(
  stream: NonNullable<typeof activeRoomStream>,
  signal: AbortSignal,
): Promise<void> {
  const storedAuth = await readStoredAuth();
  const headers = new Headers({ Accept: "application/json", "X-LetAgents-Desktop-Client": "1" });
  if (storedAuth.token) headers.set("Authorization", `Bearer ${storedAuth.token}`);
  const response = await fetch(
    `${apiUrl}/rooms/${encodeURIComponent(stream.roomIdentifier)}/messages?limit=${roomMessageHistoryPageSize}&before=latest`,
    { headers, signal },
  );
  if (!response.ok) throw new Error(`Room latest-page fetch failed with HTTP ${response.status}.`);
  const page = await response.json() as { room_id?: string; messages?: Parameters<typeof mapRoomMessagePayload>[0][] };
  for (const rawMessage of page.messages || []) {
    if (!isCurrentRoomStream(stream)) return;
    if (typeof rawMessage.id === "string") stream.lastMessageId = rawMessage.id;
    const roomIdentifier = page.room_id || stream.roomIdentifier;
    emitRoomStreamEvent({ type: "message", roomIdentifier, message: mapCloudRoomMessagePayload(rawMessage) }, {
      deliverToManagedAgents: shouldDeliverManagedMessageEvent(roomIdentifier, rawMessage.id),
    });
  }
}

// Bring the fallback long-poll up (idempotent). Called when SSE fails to
// connect or drops, so live messages keep flowing via `after={lastMessageId}`
// while the SSE reader reconnects on its existing backoff.
function startFallbackPoll(
  stream: NonNullable<typeof activeRoomStream>,
): void {
  if (stream.pollActive || !isCurrentRoomStream(stream)) return;
  stream.pollActive = true;
  void pollDesktopRoomMessages(stream);
}

// Retire the fallback long-poll and abort any in-flight request. Called once
// the SSE catch-up has closed the gap, so the room holds a single transport.
function stopFallbackPoll(
  stream: NonNullable<typeof activeRoomStream>,
): void {
  stream.pollActive = false;
  stream.pollAbortController?.abort();
  stream.pollAbortController = null;
}

// One non-blocking durable-message reconciliation run the instant SSE
// (re)connects. Broker replay covers its bounded in-memory window; this closes
// older gaps and remains the durable fallback for process restarts.
async function catchUpAfterSseOpen(
  stream: NonNullable<typeof activeRoomStream>,
): Promise<void> {
  let after = stream.lastMessageId;
  if (!after) return;
  while (isCurrentRoomStream(stream)) {
    const passStartedAt = Date.now();
    let passPages = 0;
    let passMessages = 0;
    let passBytes = 0;
    let complete = false;
    do {
      const page = await fetchRoomMessagePollPage(
        stream,
        after,
        0,
        stream.abortController.signal,
        { emitToRenderer: !stream.rendererWindowRefreshNeeded, batchRenderer: true },
      );
      passPages += 1;
      passMessages += page.messageCount;
      passBytes += page.serializedBytes;
      if (!isCurrentRoomStream(stream)) return;
      if (!page.hasMore) {
        complete = true;
        break;
      }
      if (!page.lastMessageId || page.lastMessageId === after) {
        throw new Error("Room catch-up did not advance its cursor.");
      }
      after = page.lastMessageId;
    } while (
      passPages < MAX_CATCH_UP_PAGES_PER_PASS
      && passMessages < MAX_CATCH_UP_MESSAGES_PER_PASS
      && passBytes < MAX_CATCH_UP_BYTES_PER_PASS
      && Date.now() - passStartedAt < MAX_CATCH_UP_WORK_MS_PER_PASS
    );

    if (complete) {
      if (stream.rendererWindowRefreshNeeded) {
        await emitLatestRoomMessageWindow(stream);
        stream.rendererWindowRefreshNeeded = false;
      }
      return;
    }
    stream.rendererWindowRefreshNeeded = true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function emitLatestRoomMessageWindow(
  stream: NonNullable<typeof activeRoomStream>,
): Promise<void> {
  const storedAuth = await readStoredAuth();
  const headers = new Headers({ Accept: "application/json", "X-LetAgents-Desktop-Client": "1" });
  if (storedAuth.token) headers.set("Authorization", `Bearer ${storedAuth.token}`);
  const response = await fetch(
    `${apiUrl}/rooms/${encodeURIComponent(stream.roomIdentifier)}/messages?limit=${roomMessageHistoryPageSize}&before=latest`,
    { headers, signal: stream.abortController.signal },
  );
  if (!response.ok) throw new Error(`Room latest-window fetch failed with HTTP ${response.status}.`);
  const page = await response.json() as {
    room_id?: string;
    messages?: Parameters<typeof mapRoomMessagePayload>[0][];
  };
  if (!isCurrentRoomStream(stream)) return;
  emitRoomStreamEvent({
    type: "message_window",
    roomIdentifier: page.room_id || stream.roomIdentifier,
    messages: (page.messages || []).map(mapRoomMessagePayload),
  }, { deliverToManagedAgents: false });
}

function requestDurableMessageRepair(
  stream: NonNullable<typeof activeRoomStream>,
): Promise<void> {
  stream.messageRepairRequestedGeneration += 1;
  if (stream.messageRepairPromise) return stream.messageRepairPromise;
  const drain = async () => {
    while (
      isCurrentRoomStream(stream)
      && stream.messageRepairCompletedGeneration < stream.messageRepairRequestedGeneration
    ) {
      const generation = stream.messageRepairRequestedGeneration;
      await catchUpAfterSseOpen(stream);
      stream.messageRepairCompletedGeneration = generation;
    }
  };
  const pending = drain().finally(() => {
    if (stream.messageRepairPromise === pending) stream.messageRepairPromise = null;
  });
  stream.messageRepairPromise = pending;
  return pending;
}

function repairDurableMessagesAfterBrokerGap(
  stream: NonNullable<typeof activeRoomStream>,
  gapRepairToken: number,
): void {
  // Keep one durable fallback alive until the bounded catch-up closes the
  // broker gap. Both channels share by-id managed-agent dedupe.
  startFallbackPoll(stream);
  void requestDurableMessageRepair(stream).then(() => {
    if (!isCurrentRoomStream(stream)) return;
    if (stream.pendingGapRepair?.token === gapRepairToken) {
      stream.pendingGapRepair.messagesRepaired = true;
      commitCompletedGapRepair(stream);
    }
    stopFallbackPoll(stream);
  }).catch(() => {
    if (isCurrentRoomStream(stream) && stream.pollActive) scheduleCatchUpRetry(stream);
  });
}

function clearCatchUpRetry(
  stream: NonNullable<typeof activeRoomStream>,
): void {
  if (stream.catchUpRetryTimer) {
    clearTimeout(stream.catchUpRetryTimer);
    stream.catchUpRetryTimer = null;
  }
}

// A catch-up failed while SSE (re)connected fine, so the fallback poll was left
// up as the gap-filler. Without a retry, that degraded duplicated-transport
// state would persist until the next SSE drop — which may never come. Retry on
// a bounded cadence until one catch-up succeeds and the poll is retired. The
// timer is cleared whenever its SSE connection dies (the reconnect path runs
// its own catch-up) and on stopDesktopRoomStream; the guards below make a stale
// firing a no-op even if clearing raced the timer.
function scheduleCatchUpRetry(
  stream: NonNullable<typeof activeRoomStream>,
): void {
  if (stream.catchUpRetryTimer || !isCurrentRoomStream(stream)) return;
  stream.catchUpRetryTimer = setTimeout(() => {
    stream.catchUpRetryTimer = null;
    void (async () => {
      if (!isCurrentRoomStream(stream) || !stream.pollActive) return;
      try {
        await requestDurableMessageRepair(stream);
        if (!isCurrentRoomStream(stream)) return;
        if (stream.pendingGapRepair) {
          stream.pendingGapRepair.messagesRepaired = true;
          commitCompletedGapRepair(stream);
        }
        stopFallbackPoll(stream);
      } catch {
        if (!isCurrentRoomStream(stream) || stream.abortController.signal.aborted)
          return;
        if (stream.pollActive) {
          scheduleCatchUpRetry(stream);
        }
      }
    })();
  }, catchUpRetryDelayMs);
}

async function pollLocalDesktopRoomMessages(
  stream: NonNullable<typeof activeRoomStream>,
  localRoomIdentifier: string,
): Promise<void> {
  emitRoomStreamEvent({
    type: "open",
    roomIdentifier: stream.roomIdentifier,
  });

  let observedWriteSequence = -1;
  let needsMessageDrain = true;
  let emptyCheckDelayMs = LOCAL_WRITE_SEQUENCE_POLL_INITIAL_MS;

  while (isCurrentRoomStream(stream)) {
    try {
      if (needsMessageDrain) {
        const targetWriteSequence = await localWriteSequenceReader(
          localRoomIdentifier,
        );
        let deliveredAnyMessage = false;
        let drainComplete = false;
        let drainedPages = 0;
        let drainedMessages = 0;
        let drainedBytes = 0;
        const drainStartedAt = Date.now();
        for (;;) {
          const page = await localMessagePageReader(localRoomIdentifier, {
            after: stream.lastMessageId,
            limit: roomMessageHistoryPageSize,
            readerKey: await resolveLocalThreadReaderKey(),
          });
          if (!isCurrentRoomStream(stream)) return;
          const pageMessages = await localAccountAgentRoutingHydrator(
            stream.roomIdentifier,
            localRoomIdentifier,
            page.messages.map(mapRoomMessagePayload),
          );
          if (pageMessages.some(
            (message) => message.accountAgentRouting?.authority === "invalid",
          )) {
            throw new Error("Local message routing authority is temporarily unavailable.");
          }
          for (const message of pageMessages) {
            if (!isCurrentRoomStream(stream)) return;
            const shouldEmitToRenderer = stream.localUiMessageTracker.remember(
              stream.roomIdentifier,
              message.id,
            );
            if (shouldEmitToRenderer) {
              emitRoomStreamEvent({
                type: "message",
                roomIdentifier: stream.roomIdentifier,
                message,
              }, { deliverToManagedAgents: false });
            }
            await deliverDesktopRoomMessageToManagedAgents(stream.roomIdentifier, message);
            stream.lastMessageId = message.id;
            deliveredAnyMessage = true;
          }
          drainedPages += 1;
          drainedMessages += pageMessages.length;
          drainedBytes += pageMessages.reduce(
            (total, message) => total + Buffer.byteLength(JSON.stringify(message), "utf8"),
            0,
          );
          if (!page.has_more) {
            drainComplete = true;
            break;
          }
          if (
            drainedPages >= MAX_CATCH_UP_PAGES_PER_PASS
            || drainedMessages >= MAX_CATCH_UP_MESSAGES_PER_PASS
            || drainedBytes >= MAX_CATCH_UP_BYTES_PER_PASS
            || Date.now() - drainStartedAt >= MAX_CATCH_UP_WORK_MS_PER_PASS
          ) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            break;
          }
        }
        if (!drainComplete) {
          // Retain the durable message cursor and yield between bounded passes
          // so a large or continuously growing backlog cannot monopolize the
          // Electron main loop or delay a room switch.
          continue;
        }

        const settledWriteSequence = await localWriteSequenceReader(
          localRoomIdentifier,
        );
        if (settledWriteSequence !== targetWriteSequence) {
          // A writer committed while the page was being drained. Keep the
          // cursor and immediately drain the newly signalled suffix.
          continue;
        }
        observedWriteSequence = settledWriteSequence;
        needsMessageDrain = false;
        if (deliveredAnyMessage) {
          emptyCheckDelayMs = LOCAL_WRITE_SEQUENCE_POLL_INITIAL_MS;
        }
      }

      const notificationGeneration = stream.localWriteNotificationGeneration;
      const currentWriteSequence = await localWriteSequenceReader(
        localRoomIdentifier,
      );
      if (currentWriteSequence !== observedWriteSequence) {
        needsMessageDrain = true;
        emptyCheckDelayMs = LOCAL_WRITE_SEQUENCE_POLL_INITIAL_MS;
        continue;
      }

      const notified = await waitForLocalWriteNotification(
        stream,
        notificationGeneration,
        emptyCheckDelayMs,
      );
      if (notified) {
        needsMessageDrain = true;
        emptyCheckDelayMs = LOCAL_WRITE_SEQUENCE_POLL_INITIAL_MS;
      } else {
        emptyCheckDelayMs = Math.min(
          LOCAL_WRITE_SEQUENCE_POLL_MAX_MS,
          emptyCheckDelayMs * 2,
        );
      }
    } catch (error) {
      if (!isCurrentRoomStream(stream)) return;
      emitRoomStreamEvent({
        type: "error",
        roomIdentifier: stream.roomIdentifier,
        message:
          error instanceof Error
            ? error.message
            : "Local room polling disconnected.",
      });
      await waitForLocalWriteNotification(
        stream,
        stream.localWriteNotificationGeneration,
        2_500,
      );
      needsMessageDrain = true;
    }
  }
}

function waitForLocalWriteNotification(
  stream: NonNullable<typeof activeRoomStream>,
  notificationGeneration: number,
  timeoutMs: number,
): Promise<boolean> {
  if (!isCurrentRoomStream(stream)) return Promise.resolve(false);
  if (stream.localWriteNotificationGeneration !== notificationGeneration) {
    return Promise.resolve(true);
  }
  localWriteWaitScheduledObserverForTest?.(timeoutMs);
  if (localWriteWaiterForTest) {
    return localWriteWaiterForTest(timeoutMs);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (notified: boolean) => {
      if (settled) return;
      settled = true;
      localWriteWaitResolvedObserverForTest?.(notified);
      clearTimeout(timer);
      if (stream.localWriteWake === onWrite) stream.localWriteWake = null;
      resolve(notified);
    };
    const onWrite = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    stream.localWriteWake = onWrite;
    if (stream.localWriteNotificationGeneration !== notificationGeneration) {
      finish(true);
    }
  });
}

function parseRoomStreamChunk(
  stream: NonNullable<typeof activeRoomStream>,
  chunk: string,
): string {
  const frames = chunk.split(/\n\n/);
  const remainder = frames.pop() || "";

  for (const frame of frames) {
    const lines = frame.split(/\r?\n/);
    let eventName = "message";
    let eventCursor: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("id:")) {
        eventCursor = line.slice("id:".length).trim() || null;
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    queueOrHandleRoomStreamFrame(stream, eventName, dataLines.join("\n"), eventCursor);
  }

  return remainder;
}

async function readDesktopRoomStreamBody(
  stream: NonNullable<typeof activeRoomStream>,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bufferBytes = 0;
  while (isCurrentRoomStream(stream)) {
    const { done, value } = await reader.read();
    if (!isCurrentRoomStream(stream) || done) break;
    const decoded = decoder.decode(value, { stream: true });
    const combined = buffer + decoded;
    bufferBytes += value.byteLength;
    buffer = parseRoomStreamChunk(
      stream,
      combined,
    );
    if (buffer.length < combined.length) bufferBytes = Buffer.byteLength(buffer, "utf8");
    if (bufferBytes > MAX_NATIVE_SSE_FRAME_BYTES) {
      // Treat an unterminated oversized frame exactly like a broker gap. Do
      // not reconnect with a cursor that may have skipped its hidden event.
      stream.lastEventCursor = null;
      clearRoomEventCursor(stream.roomIdentifier);
      const gapRepairToken = ++stream.gapRepairGeneration;
      stream.pendingGapRepair = {
        token: gapRepairToken,
        cursorPresent: false,
        cursor: null,
        messagesRepaired: false,
        snapshotRepaired: false,
      };
      emitRoomStreamEvent({
        type: "open",
        roomIdentifier: stream.roomIdentifier,
        checkpoint: stream.lastMessageId,
        gap: true,
        verified: true,
        deliveryRepairToken: gapRepairToken,
      }, { deliverToManagedAgents: false });
      repairDurableMessagesAfterBrokerGap(stream, gapRepairToken);
      await reader.cancel("SSE frame exceeded bounded size").catch(() => undefined);
      throw new Error("Room stream frame exceeded bounded size.");
    }
  }
}

async function openDesktopRoomStream(
  stream: NonNullable<typeof activeRoomStream>,
): Promise<void> {
  const storedAuth = await readStoredAuth();
  const requestHeaders = new Headers({
    Accept: "text/event-stream",
    "X-LetAgents-Desktop-Client": "1",
  });
  if (storedAuth.token) {
    requestHeaders.set("Authorization", `Bearer ${storedAuth.token}`);
  }
  if (stream.lastEventCursor) {
    requestHeaders.set("Last-Event-ID", stream.lastEventCursor);
  }

  try {
    const streamParams = new URLSearchParams();
    if (stream.lastMessageId) streamParams.set("after", stream.lastMessageId);
    streamParams.append("stream_capability", "resource_invalidation_v1");
    const response = await fetch(
      `${apiUrl}/rooms/${encodeURIComponent(stream.roomIdentifier)}/messages/stream?${streamParams.toString()}`,
      {
        headers: requestHeaders,
        signal: stream.abortController.signal,
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`Room stream failed with HTTP ${response.status}.`);
    }

    stream.retryMs = 1000;
    emitRoomStreamEvent({
      type: "open",
      roomIdentifier: stream.roomIdentifier,
      checkpoint: stream.lastMessageId,
      gap: false,
      verified: false,
    });
    stream.handshakeReceived = false;
    if (stream.handshakeTimer) clearTimeout(stream.handshakeTimer);
    stream.handshakeTimer = setTimeout(() => {
      stream.handshakeTimer = null;
      if (!isCurrentRoomStream(stream) || stream.handshakeReceived) return;
      emitRoomStreamEvent({
        type: "open",
        roomIdentifier: stream.roomIdentifier,
        checkpoint: stream.lastMessageId,
        gap: true,
        verified: false,
      }, { deliverToManagedAgents: false });
      stream.resolveReady?.();
      stream.resolveReady = null;
    }, roomSyncHandshakeTimeoutMs);

    // Begin draining the socket immediately. Durable catch-up may span
    // multiple pages, so leaving the body unread can overflow transport/server
    // buffers. Frames are held in a bounded local queue until catch-up closes
    // the older history gap, then replayed in wire order.
    stream.deferSseFrames = true;
    stream.bufferedSseFrames = [];
    stream.bufferedSseFrameBytes = 0;
    stream.bufferedSseFrameOverflow = false;
    const readerOutcome = readDesktopRoomStreamBody(stream, response.body).then(
      () => null,
      (error: unknown) => error,
    );

    // --- SSE just (re)connected: close the gap, then retire the fallback. ---
    // Ordering is what keeps this lossless and (near) duplicate-free across the
    // hand-off from the fallback long-poll back to SSE:
    //   1. The body reader is already draining the socket, but every parsed
    //      frame stays in the bounded deferred queue above. No SSE `message`
    //      frame can be emitted into application state during the catch-up.
    //   2. The catch-up fetches `after={lastMessageId}`, so it delivers exactly
    //      the messages the server holds beyond our cursor (the SSE-replay gap),
    //      advancing `lastMessageId` as it goes.
    //   3. Only after the catch-up succeeds do we stop the fallback poll. A
    //      fallback request may still be in flight; aborting it here cannot drop
    //      anything, because whatever it would have returned is at/after our
    //      cursor and was either just delivered by the catch-up or will arrive
    //      on the SSE reader we start next. Any id delivered by both channels in
    //      the overlap window is collapsed by the existing by-id dedupe
    //      (managedMessageDeliveryTracker for agents; message id downstream in
    //      the renderer), so overlap is at worst a redundant emit, never a loss.
    //   4. If the catch-up itself fails, we deliberately leave the fallback poll
    //      running as the gap-filler and still start the SSE reader; a bounded
    //      retry (scheduleCatchUpRetry) keeps re-running the catch-up until one
    //      succeeds and retires the poll — otherwise a single failed catch-up
    //      would pin the duplicated-transport state until the next SSE drop.
    try {
      await requestDurableMessageRepair(stream);
      if (!isCurrentRoomStream(stream)) return;
      if (stream.pendingGapRepair) {
        stream.pendingGapRepair.messagesRepaired = true;
        commitCompletedGapRepair(stream);
      }
      stopFallbackPoll(stream);
    } catch {
      if (!isCurrentRoomStream(stream) || stream.abortController.signal.aborted)
        return;
      // A first-connect catch-up may fail before any fallback exists. Bring the
      // durable lane up in both initial and reconnect cases, then keep retrying
      // until the message cursor *and* any pending renderer window are repaired.
      startFallbackPoll(stream);
      scheduleCatchUpRetry(stream);
    }

    finishDeferredSseFrames(stream);
    const readerError = await readerOutcome;
    if (readerError) throw readerError;
  } catch (error) {
    if (!isCurrentRoomStream(stream) || stream.abortController.signal.aborted)
      return;
    emitRoomStreamEvent({
      type: "error",
      roomIdentifier: stream.roomIdentifier,
      message:
        error instanceof Error ? error.message : "Room stream disconnected.",
    });
  }

  if (isCurrentRoomStream(stream)) {
    // SSE is down (connect failed or the read loop dropped). Any pending
    // catch-up retry belonged to the connection that just died; drop it — the
    // reconnect below runs its own catch-up on open. Then bring up the fallback
    // long-poll so messages keep flowing via `after={lastMessageId}` while the
    // SSE reader reconnects on its existing exponential backoff.
    clearCatchUpRetry(stream);
    startFallbackPoll(stream);
    // A failed SSE transport cannot provide room_sync. Unblock the initial
    // snapshot only after the durable long-poll fallback has been started.
    if (stream.resolveReady) {
      emitRoomStreamEvent({
        type: "open",
        roomIdentifier: stream.roomIdentifier,
        checkpoint: stream.lastMessageId,
        gap: true,
        verified: false,
      }, { deliverToManagedAgents: false });
    }
    stream.resolveReady?.();
    stream.resolveReady = null;
    const retryMs = Math.min(stream.retryMs, 30_000);
    stream.retryMs = Math.min(stream.retryMs * 2, 30_000);
    stream.reconnectTimer = setTimeout(() => {
      stream.reconnectTimer = null;
      void openDesktopRoomStream(stream);
    }, retryMs);
  }
}

export async function startDesktopRoomStream(
  roomIdentifier: string,
  afterMessageId?: string | null,
): Promise<void> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before opening the live stream.");
  }

  if (
    activeRoomStream?.roomIdentifier === trimmedRoomIdentifier &&
    !activeRoomStream.stopped
  ) {
    if (afterMessageId) {
      activeRoomStream.lastMessageId = afterMessageId;
    }
    await activeRoomStream.readyPromise;
    return;
  }

  await stopDesktopRoomStream();
  let resolveReady: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
  activeRoomStream = {
    roomIdentifier: trimmedRoomIdentifier,
    canonicalRoomIdentifier: null,
    abortController: new AbortController(),
    reconnectTimer: null,
    pollAbortController: null,
    retryMs: 1000,
    lastMessageId: afterMessageId || null,
    lastEventCursor: roomEventCursors.get(trimmedRoomIdentifier) ?? null,
    localRoomIdentifier: null,
    managedMessageDeliveryTracker: createManagedMessageDeliveryTracker(),
    managedTaskDeliveryTracker: createManagedMessageDeliveryTracker(),
    localUiMessageTracker: createManagedMessageDeliveryTracker(),
    localWriteNotificationGeneration: 0,
    localWriteWake: null,
    messageRepairRequestedGeneration: 0,
    messageRepairCompletedGeneration: 0,
    messageRepairPromise: null,
    rendererWindowRefreshNeeded: false,
    gapRepairGeneration: 0,
    pendingGapRepair: null,
    stopped: false,
    pollActive: false,
    catchUpRetryTimer: null,
    handshakeTimer: null,
    handshakeReceived: false,
    readyPromise,
    resolveReady,
    readyTimer: null,
    deferSseFrames: false,
    bufferedSseFrames: [],
    bufferedSseFrameBytes: 0,
    bufferedSseFrameOverflow: false,
  };
  const startingStream = activeRoomStream;
  startingStream.readyTimer = setTimeout(() => {
    startingStream.readyTimer = null;
    if (!isCurrentRoomStream(startingStream) || !startingStream.resolveReady) return;
    startingStream.resolveReady();
    startingStream.resolveReady = null;
    emitRoomStreamEvent({
      type: "open",
      roomIdentifier: startingStream.roomIdentifier,
      checkpoint: startingStream.lastMessageId,
      gap: true,
      verified: false,
    }, { deliverToManagedAgents: false });
  }, roomSyncHandshakeTimeoutMs);
  if (isDesktopSmokeCheck()) {
    emitRoomStreamEvent({
      type: "open",
      roomIdentifier: trimmedRoomIdentifier,
    });
    activeRoomStream.resolveReady?.();
    activeRoomStream.resolveReady = null;
    return;
  }
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    activeRoomStream.localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    void pollLocalDesktopRoomMessages(
      activeRoomStream,
      activeRoomStream.localRoomIdentifier,
    );
    activeRoomStream.resolveReady?.();
    activeRoomStream.resolveReady = null;
    return;
  }
  // Cloud rooms start with SSE only. The long-poll is now a fallback that
  // `openDesktopRoomStream` brings up if/when SSE drops, and retires again on
  // reconnect — instead of running a second permanent transport per room.
  void openDesktopRoomStream(activeRoomStream);
  await activeRoomStream.readyPromise;
}

export async function stopDesktopRoomStream(
  roomIdentifier?: string | null,
): Promise<void> {
  if (!activeRoomStream) return;
  if (
    roomIdentifier &&
    activeRoomStream.roomIdentifier !== roomIdentifier.trim()
  )
    return;

  clearLocalManagedMessageDeliveryRetries(activeRoomStream.roomIdentifier);
  activeRoomStream.stopped = true;
  activeRoomStream.localWriteWake?.();
  activeRoomStream.localWriteWake = null;
  activeRoomStream.resolveReady?.();
  activeRoomStream.resolveReady = null;
  if (activeRoomStream.readyTimer) {
    clearTimeout(activeRoomStream.readyTimer);
    activeRoomStream.readyTimer = null;
  }
  activeRoomStream.pollActive = false;
  activeRoomStream.abortController.abort();
  if (activeRoomStream.handshakeTimer) {
    clearTimeout(activeRoomStream.handshakeTimer);
    activeRoomStream.handshakeTimer = null;
  }
  activeRoomStream.pollAbortController?.abort();
  if (activeRoomStream.reconnectTimer) {
    clearTimeout(activeRoomStream.reconnectTimer);
  }
  clearCatchUpRetry(activeRoomStream);
  activeRoomStream = null;
}
