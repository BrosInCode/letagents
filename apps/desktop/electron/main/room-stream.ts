import type {
  DesktopManagedAgentSession,
  DesktopRentalActivityEvent,
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
  getLocalChatThreadRoutingAgentKeysForRoots,
} from "./rooms/messages/local-store.js";
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
  abortController: AbortController;
  reconnectTimer: NodeJS.Timeout | null;
  pollAbortController: AbortController | null;
  retryMs: number;
  lastMessageId: string | null;
  localRoomIdentifier: string | null;
  managedMessageDeliveryTracker: ManagedMessageDeliveryTracker;
  localUiMessageTracker: ManagedMessageDeliveryTracker;
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
} | null = null;

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

type ManagedAgentRoomStreamDispatcher = typeof dispatchRoomStreamEventToManagedAgents;
let managedAgentRoomStreamDispatcher: ManagedAgentRoomStreamDispatcher =
  dispatchRoomStreamEventToManagedAgents;

export function setLocalAccountAgentRoutingHydratorForTest(
  hydrator: LocalAccountAgentRoutingHydrator | null,
): void {
  localAccountAgentRoutingHydrator = hydrator ?? attachLocalAccountAgentRouting;
}

export function setManagedAgentRoomStreamDispatcherForTest(
  dispatcher: ManagedAgentRoomStreamDispatcher | null,
): void {
  managedAgentRoomStreamDispatcher = dispatcher ?? dispatchRoomStreamEventToManagedAgents;
}

export function emitPersistedLocalRoomMessage(
  roomIdentifier: string,
  message: DesktopRoomMessage,
): void {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const stream = activeRoomStream;
  if (
    !stream ||
    stream.roomIdentifier !== trimmedRoomIdentifier ||
    stream.stopped ||
    !stream.localRoomIdentifier
  ) {
    return;
  }

  // The renderer gets the locally persisted message immediately, but the
  // durable poll remains responsible for advancing the room cursor. Managed
  // delivery starts now for low latency and is deduped against the later poll;
  // if projection is temporarily unavailable, leaving the cursor untouched
  // guarantees that the persisted row is retried in order.
  stream.localUiMessageTracker.remember(trimmedRoomIdentifier, message.id);
  emitRoomStreamEvent({
    type: "message",
    roomIdentifier: trimmedRoomIdentifier,
    message,
  }, { deliverToManagedAgents: false });
  void deliverDesktopRoomMessageToManagedAgents(trimmedRoomIdentifier, message);
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

function handleRoomStreamFrame(
  roomIdentifier: string,
  eventName: string,
  data: string,
): void {
  if (!data.trim()) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }

  const eventRoomIdentifier =
    typeof payload.room_id === "string" ? payload.room_id : roomIdentifier;
  if (eventName === "task_update") {
    const task = mapRoomStreamTaskPayload(payload);
    if (task) {
      emitRoomStreamEvent({
        type: "task_update",
        roomIdentifier: eventRoomIdentifier,
        task,
      });
    }
    return;
  }

  if (eventName === "room_sync") {
    if (activeRoomStream?.roomIdentifier === roomIdentifier) {
      activeRoomStream.handshakeReceived = true;
      if (activeRoomStream.handshakeTimer) clearTimeout(activeRoomStream.handshakeTimer);
      activeRoomStream.handshakeTimer = null;
      activeRoomStream.resolveReady?.();
      activeRoomStream.resolveReady = null;
      if (activeRoomStream.readyTimer) clearTimeout(activeRoomStream.readyTimer);
      activeRoomStream.readyTimer = null;
    }
    emitRoomStreamEvent({
      type: "open",
      roomIdentifier: eventRoomIdentifier,
      checkpoint: typeof payload.checkpoint === "string" ? payload.checkpoint : null,
      gap: payload.gap === true,
      verified: true,
    }, { deliverToManagedAgents: false });
    return;
  }

  if (eventName === "github_event") {
    const event = mapGitHubRoomEventPayload(payload);
    if (event) {
      emitRoomStreamEvent({
        type: "github_event",
        roomIdentifier: eventRoomIdentifier,
        event,
      });
    }
    return;
  }

  if (eventName === "artifact_update") {
    const artifact = mapRoomArtifactPayload(
      payload.artifact && typeof payload.artifact === "object"
        ? payload.artifact as Parameters<typeof mapRoomArtifactPayload>[0]
        : null,
    );
    emitRoomStreamEvent({
      type: "artifact_update",
      roomIdentifier: eventRoomIdentifier,
      artifactIdentityKey:
        typeof payload.artifact_identity_key === "string"
          ? payload.artifact_identity_key
          : artifact?.identityKey ?? null,
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
      emitRoomStreamEvent({
        type: "reasoning_update",
        roomIdentifier: eventRoomIdentifier,
        session: mapDesktopReasoningSessionPayload(
          session as Parameters<typeof mapDesktopReasoningSessionPayload>[0],
        ),
      });
    }
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
      emitRoomStreamEvent({
        type: "reasoning_remove",
        roomIdentifier: eventRoomIdentifier,
        sessionId,
      });
    }
    return;
  }

  if (eventName === "rental_activity") {
    const activity = readStreamActivity(payload);
    if (activity) {
      emitRoomStreamEvent({
        type: "rental_activity",
        roomIdentifier: eventRoomIdentifier,
        activity,
      });
    }
    return;
  }

  if (eventName === "rental_patch") {
    const activity = readStreamActivity(payload);
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
    emitRoomStreamEvent({
      type: "rental_usage",
      roomIdentifier: eventRoomIdentifier,
      activity,
      sessionId: activity?.sessionId || null,
    });
    return;
  }

  if (eventName === "session_disconnect") {
    emitRoomStreamEvent({
      type: "session_disconnect",
      roomIdentifier: eventRoomIdentifier,
      message: "Room stream disconnected.",
    });
    return;
  }

  if (eventName === "message") {
    const messageId = typeof payload.id === "string" ? payload.id : null;
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
): Promise<{ hasMore: boolean; lastMessageId: string | null }> {
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
    return { hasMore: false, lastMessageId: stream.lastMessageId };
  }
  for (const rawMessage of page.messages || []) {
    if (!isCurrentRoomStream(stream)) {
      return { hasMore: false, lastMessageId: stream.lastMessageId };
    }
    if (typeof rawMessage.id === "string") {
      stream.lastMessageId = rawMessage.id;
    }
    const roomIdentifier = page.room_id || stream.roomIdentifier;
    emitRoomStreamEvent({
      type: "message",
      roomIdentifier,
      message: mapCloudRoomMessagePayload(rawMessage),
    }, { deliverToManagedAgents: shouldDeliverManagedMessageEvent(roomIdentifier, rawMessage.id) });
  }
  return { hasMore: page.has_more === true, lastMessageId: stream.lastMessageId };
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

// One non-blocking gap-fill fetch run the instant SSE (re)connects. The server
// keeps no SSE replay, so a fresh/reconnected SSE reader only sees events from
// now on; this closes the gap between the last delivered message and stream
// start using the same `after={lastMessageId}` cursor the fallback poll uses.
async function catchUpAfterSseOpen(
  stream: NonNullable<typeof activeRoomStream>,
): Promise<void> {
  let after = stream.lastMessageId;
  if (!after) return;
  do {
    const page = await fetchRoomMessagePollPage(
      stream,
      after,
      0,
      stream.abortController.signal,
    );
    if (!isCurrentRoomStream(stream) || !page.hasMore) return;
    if (!page.lastMessageId || page.lastMessageId === after) {
      throw new Error("Room catch-up did not advance its cursor.");
    }
    after = page.lastMessageId;
  } while (true);
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
        await catchUpAfterSseOpen(stream);
        if (!isCurrentRoomStream(stream)) return;
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

  while (isCurrentRoomStream(stream)) {
    try {
      const page = await getLocalChatMessages(localRoomIdentifier, {
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
      if (pageMessages.some((message) => message.accountAgentRouting?.authority === "invalid")) {
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
      }
      await new Promise((resolve) => setTimeout(resolve, page.messages.length ? 250 : 1500));
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
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }
}

function parseRoomStreamChunk(roomIdentifier: string, chunk: string): string {
  const frames = chunk.split(/\n\n/);
  const remainder = frames.pop() || "";

  for (const frame of frames) {
    const lines = frame.split(/\r?\n/);
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    handleRoomStreamFrame(roomIdentifier, eventName, dataLines.join("\n"));
  }

  return remainder;
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

  try {
    const response = await fetch(
      `${apiUrl}/rooms/${encodeURIComponent(stream.roomIdentifier)}/messages/stream${
        stream.lastMessageId ? `?after=${encodeURIComponent(stream.lastMessageId)}` : ""
      }`,
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

    // --- SSE just (re)connected: close the gap, then retire the fallback. ---
    // Ordering is what keeps this lossless and (near) duplicate-free across the
    // hand-off from the fallback long-poll back to SSE:
    //   1. We have NOT started reading `response.body` yet, so no SSE `message`
    //      frame can be emitted during the catch-up — the socket just buffers.
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
      await catchUpAfterSseOpen(stream);
      if (!isCurrentRoomStream(stream)) return;
      stopFallbackPoll(stream);
    } catch {
      if (!isCurrentRoomStream(stream) || stream.abortController.signal.aborted)
        return;
      // Keep the fallback poll alive; the SSE reader still runs below.
      if (stream.pollActive) {
        scheduleCatchUpRetry(stream);
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (isCurrentRoomStream(stream)) {
      const { done, value } = await reader.read();
      if (!isCurrentRoomStream(stream)) break;
      if (done) break;
      buffer = parseRoomStreamChunk(
        stream.roomIdentifier,
        buffer + decoder.decode(value, { stream: true }),
      );
    }
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
    abortController: new AbortController(),
    reconnectTimer: null,
    pollAbortController: null,
    retryMs: 1000,
    lastMessageId: afterMessageId || null,
    localRoomIdentifier: null,
    managedMessageDeliveryTracker: createManagedMessageDeliveryTracker(),
    localUiMessageTracker: createManagedMessageDeliveryTracker(),
    stopped: false,
    pollActive: false,
    catchUpRetryTimer: null,
    handshakeTimer: null,
    handshakeReceived: false,
    readyPromise,
    resolveReady,
    readyTimer: null,
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
