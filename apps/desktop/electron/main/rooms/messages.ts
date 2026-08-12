import type {
  DesktopLocalChatSyncResult,
  DesktopMessageInfo,
  DesktopRoomMessage,
  DesktopTaskSummary,
  DesktopRoomLatestMessage,
  DesktopRoomMessagesPage,
  DesktopRoomThreadInboxFilter,
  DesktopRoomThreadInboxPage,
  DesktopRoomThreadPage,
  DesktopRoomThreadReadResult,
  DesktopSendRoomMessageResult,
} from "../../ipc-types.js";
import { parsePositivePgIntegerScopedId } from "../../../../../shared/message-contracts.mjs";
import { apiFetch, DesktopApiError, readStoredAuth } from "../auth.js";
import {
  consumeLocalStagedAttachments,
  publishLocalAttachmentPayload,
} from "../attachments.js";
import {
  addLocalChatMessage,
  claimUnsyncedLocalChatMessages,
  getLatestLocalChatMessages,
  getLocalChatMessagesBefore,
  getLocalChatMessagesAround,
  getLocalMessageThread,
  getLocalMessageThreads,
  getSyncedCloudMessageId,
  markLocalMessageThreadRead,
  markLocalChatMessageSynced,
} from "./messages/local-store.js";
import {
  readChatStorageSettings,
  setChatStorageMode,
  setRoomStorageMode,
} from "../chat-storage/settings.js";
import {
  assertLocalRoomPublishable,
  claimLocalTasksForPublish,
  cloudRoomIdentifierForStorage,
  getLocalRoom,
  getLocalRoomByCloudRoom,
  getLocalTaskCloudId,
  localRoomIdentifierForStorage,
  linkLocalRoomToCloud,
  markLocalTaskSynced,
  rememberLocalTaskCloudId,
  releaseLocalTaskPublishClaim,
  resolveLocalAwareRoomStorageMode,
} from "./local-store.js";
import { roomMessageHistoryPageSize } from "../paths.js";
import { desktopSmokeRoomSnapshot, isDesktopSmokeCheck } from "../smoke.js";
import {
  mapCloudRoomMessagePayload,
  mapRoomMessagePayload,
  mapRoomMessageThreadSummary,
  type RoomMessagePayload,
} from "./messages/mappers.js";
import { resolveLocalThreadReaderKey } from "./messages/thread-reader.js";
import {
  getStoredAgentSession,
  type StoredAgentSessionState,
} from "../agents/state.js";

export { mapCloudRoomMessagePayload, mapRoomMessagePayload, type RoomMessagePayload };

export function desktopMessageAccountRoutingRequest(
  headers: Record<string, string> = {},
): { headers: Record<string, string> } {
  return {
    headers: {
      ...headers,
      "X-LetAgents-Desktop-Client": "1",
    },
  };
}

type RoomThreadInboxPayload = {
  threads: Array<{
    root: RoomMessagePayload;
    summary: NonNullable<RoomMessagePayload["thread"]>;
  }>;
  has_more: boolean;
  unread_thread_count: number;
};

export async function sendDesktopRoomMessage(
  roomIdentifier: string,
  text: string,
  replyTo?: string | null,
  attachments: Array<{ upload_id: string }> = [],
  threadRootId?: string | null,
): Promise<DesktopSendRoomMessageResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedText = text.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before sending a message.");
  }
  if (!trimmedText && attachments.length === 0) {
    throw new Error("Write a message before sending.");
  }

  const storedAuth = await readStoredAuth();
  const sender =
    storedAuth.account?.displayName || storedAuth.account?.login || "Desktop";
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const localAttachments = consumeLocalStagedAttachments(
      localRoomIdentifier,
      attachments,
    );
    const message = await addLocalChatMessage(localRoomIdentifier, {
      sender,
      text: trimmedText,
      reply_to: replyTo || null,
      thread_root_id: threadRootId || null,
      source: "browser",
      attachments: localAttachments,
      readerKey: await resolveLocalThreadReaderKey(storedAuth),
    });
    return {
      message: mapRoomMessagePayload(message),
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const message = await apiFetch<RoomMessagePayload>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages`,
    {
      method: "POST",
      ...desktopMessageAccountRoutingRequest({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        sender,
        text: trimmedText,
        reply_to: replyTo || null,
        thread_root_id: threadRootId || null,
        attachments,
      }),
    },
  );

  return {
    message: mapCloudRoomMessagePayload(message),
  };
}

export async function getDesktopRoomThread(
  roomIdentifier: string,
  threadRootId: string,
  beforeMessageId?: string | null,
  limit = roomMessageHistoryPageSize,
): Promise<DesktopRoomThreadPage> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedThreadRootId = threadRootId.trim();
  const trimmedBeforeMessageId = beforeMessageId?.trim() || null;
  if (!trimmedRoomIdentifier || !trimmedThreadRootId) {
    throw new Error("Choose a thread before opening it.");
  }

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const page = await getLocalMessageThread(localRoomIdentifier, trimmedThreadRootId, {
      before: trimmedBeforeMessageId,
      limit,
      readerKey: await resolveLocalThreadReaderKey(),
    });
    if (!page) {
      throw new Error("Thread not found.");
    }
    return {
      root: mapRoomMessagePayload(page.root),
      replies: page.replies.map(mapRoomMessagePayload),
      summary: mapRoomMessageThreadSummary(page.summary),
      hasOlder: page.has_older,
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const params = new URLSearchParams({ limit: String(limit) });
  if (trimmedBeforeMessageId) params.set("before", trimmedBeforeMessageId);
  const page = await apiFetch<{
    root: RoomMessagePayload;
    replies?: RoomMessagePayload[];
    summary?: RoomMessagePayload["thread"];
    has_older?: boolean;
  }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages/${encodeURIComponent(trimmedThreadRootId)}/thread?${params.toString()}`,
    desktopMessageAccountRoutingRequest(),
  );
  const summary = mapRoomMessageThreadSummary(
    page.summary ?? page.root.thread ?? null,
  );
  if (!summary) {
    throw new Error("Thread not found.");
  }
  const root = mapRoomMessagePayload(page.root);
  return {
    root,
    replies: (page.replies || []).map(mapRoomMessagePayload),
    summary,
    hasOlder: Boolean(page.has_older),
  };
}

export async function getDesktopRoomThreads(
  roomIdentifier: string,
  filter: DesktopRoomThreadInboxFilter = "all",
  beforeMessageId?: string | null,
  limit = roomMessageHistoryPageSize,
): Promise<DesktopRoomThreadInboxPage> {
  const trimmedRoomIdentifier = typeof roomIdentifier === "string" ? roomIdentifier.trim() : "";
  const trimmedBeforeMessageId = typeof beforeMessageId === "string" ? beforeMessageId.trim() || null : null;
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before opening the inbox.");
  }
  if (beforeMessageId !== undefined && beforeMessageId !== null && typeof beforeMessageId !== "string") {
    throw new Error("Thread inbox cursor must be a message id.");
  }
  if (trimmedBeforeMessageId && !parsePositivePgIntegerScopedId(trimmedBeforeMessageId, "msg")) {
    throw new Error("Thread inbox cursor must be a message id.");
  }
  if (filter !== "all" && filter !== "unread") {
    throw new Error("Thread inbox filter must be all or unread.");
  }
  const normalizedLimit = normalizeThreadInboxLimit(limit);

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const page = await getLocalMessageThreads(localRoomIdentifier, {
      filter,
      before: trimmedBeforeMessageId,
      limit: normalizedLimit,
      readerKey: await resolveLocalThreadReaderKey(),
    });
    return {
      threads: page.threads.map((item) => ({
        root: mapRoomMessagePayload(item.root),
        summary: mapRoomMessageThreadSummary(item.summary),
      })),
      hasMore: page.has_more,
      unreadThreadCount: page.unread_thread_count,
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const params = new URLSearchParams({
    filter,
    limit: String(normalizedLimit),
  });
  if (trimmedBeforeMessageId) params.set("before", trimmedBeforeMessageId);
  try {
    const page = await apiFetch<RoomThreadInboxPayload>(
      `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages/threads?${params.toString()}`,
      desktopMessageAccountRoutingRequest(),
    );
    return mapThreadInboxPayload(page);
  } catch (error) {
    if (isMissingThreadRouteError(error)) {
      return emptyThreadInboxPage();
    }
    throw error;
  }
}

/**
 * A bare 404 (no machine-readable `code`) means an older server that does not
 * expose the thread-inbox route yet — treat that as "no thread inbox" and
 * render an empty inbox. A 404 that carries a code (e.g. ROOM_NOT_FOUND) is a
 * real error about a specific room and must surface rather than be masked as an
 * empty inbox, along with every non-404 error (auth, 5xx, malformed).
 */
export function isMissingThreadRouteError(error: unknown): boolean {
  return (
    error instanceof DesktopApiError &&
    error.status === 404 &&
    !error.payload?.code
  );
}

function emptyThreadInboxPage(): DesktopRoomThreadInboxPage {
  return { threads: [], hasMore: false, unreadThreadCount: 0 };
}

function normalizeThreadInboxLimit(limit: unknown): number {
  if (limit === null || limit === undefined) return roomMessageHistoryPageSize;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return roomMessageHistoryPageSize;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function mapThreadInboxPayload(page: RoomThreadInboxPayload): DesktopRoomThreadInboxPage {
  if (!Array.isArray(page.threads)) {
    throw new Error("Thread inbox response is missing threads.");
  }
  const unreadThreadCount = Number(page.unread_thread_count);
  if (!Number.isFinite(unreadThreadCount)) {
    throw new Error("Thread inbox response is missing unread count.");
  }
  return {
    threads: page.threads.map((item) => {
      if (!item?.root || !item.summary) {
        throw new Error("Thread inbox response included an incomplete thread.");
      }
      return {
        root: mapRoomMessagePayload(item.root),
        summary: mapRoomMessageThreadSummary(item.summary),
      };
    }),
    hasMore: Boolean(page.has_more),
    unreadThreadCount,
  };
}

export async function markDesktopRoomThreadRead(
  roomIdentifier: string,
  threadRootId: string,
  messageId?: string | null,
): Promise<DesktopRoomThreadReadResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedThreadRootId = threadRootId.trim();
  const trimmedMessageId = messageId?.trim() || null;
  if (!trimmedRoomIdentifier || !trimmedThreadRootId) {
    throw new Error("Choose a thread before marking it read.");
  }

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const summary = await markLocalMessageThreadRead(
      localRoomIdentifier,
      trimmedThreadRootId,
      trimmedMessageId,
      { readerKey: await resolveLocalThreadReaderKey() },
    );
    if (!summary) {
      throw new Error("Thread not found.");
    }
    return {
      thread: mapRoomMessageThreadSummary(summary),
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const result = await apiFetch<{
    thread?: RoomMessagePayload["thread"];
  }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages/${encodeURIComponent(trimmedThreadRootId)}/thread/read`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({ message_id: trimmedMessageId }),
    },
  );
  const mapped = mapRoomMessageThreadSummary(result.thread);
  if (!mapped) {
    throw new Error("Thread read state could not be updated.");
  }
  return { thread: mapped };
}

export async function getDesktopRoomMessagesBefore(
  roomIdentifier: string,
  beforeMessageId: string,
  limit = roomMessageHistoryPageSize,
): Promise<DesktopRoomMessagesPage> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedBeforeMessageId = beforeMessageId.trim();
  if (!trimmedRoomIdentifier || !trimmedBeforeMessageId) {
    return { messages: [], hasOlder: false };
  }

  if (isDesktopSmokeCheck()) {
    return { messages: [], hasOlder: false };
  }

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const page = await getLocalChatMessagesBefore(
      localRoomIdentifier,
      trimmedBeforeMessageId,
      { limit, readerKey: await resolveLocalThreadReaderKey() },
    );
    return {
      messages: page.messages.map(mapRoomMessagePayload),
      hasOlder: page.has_more,
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const page = await apiFetch<{
    messages?: RoomMessagePayload[];
    has_older?: boolean;
    has_more?: boolean;
  }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages?limit=${encodeURIComponent(String(limit))}&before=${encodeURIComponent(trimmedBeforeMessageId)}`,
    desktopMessageAccountRoutingRequest(),
  );

  return {
    messages: [...(page.messages || [])]
      .sort(
        (left, right) =>
          Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""),
      )
      .map(mapRoomMessagePayload),
    hasOlder: Boolean(page.has_older ?? page.has_more),
  };
}

export async function getDesktopRoomMessage(
  roomIdentifier: string,
  messageId: string,
): Promise<DesktopRoomMessage | null> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedMessageId = messageId.trim();
  if (!trimmedRoomIdentifier || !parsePositivePgIntegerScopedId(trimmedMessageId, "msg")) return null;
  if (isDesktopSmokeCheck()) return null;

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const page = await getLocalChatMessagesAround(
      localRoomIdentifier,
      trimmedMessageId,
      { before: 0, after: 0 },
    );
    const message = page.messages.find((candidate) => candidate.id === trimmedMessageId);
    return message ? mapRoomMessagePayload(message) : null;
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const response = await apiFetch<{ message?: RoomMessagePayload | null }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages/${encodeURIComponent(trimmedMessageId)}`,
    desktopMessageAccountRoutingRequest(),
  );
  return response.message ? mapRoomMessagePayload(response.message) : null;
}

export async function getDesktopRoomLatestMessages(
  roomIdentifiers: string[],
): Promise<DesktopRoomLatestMessage[]> {
  if (isDesktopSmokeCheck()) {
    const snapshot = desktopSmokeRoomSnapshot();
    const latest = snapshot.messages.at(-1) || null;
    return roomIdentifiers.filter(Boolean).map((roomIdentifier) => ({
      roomIdentifier,
      latestMessageId: latest?.id || null,
      latestMessageAt: latest?.timestamp || null,
    }));
  }

  const identifiers = [
    ...new Set(
      roomIdentifiers
        .map((roomIdentifier) => roomIdentifier.trim())
        .filter(Boolean),
    ),
  ].slice(0, 100);
  if (!identifiers.length) return [];

  const results = await Promise.all(
    identifiers.map(async (roomIdentifier): Promise<DesktopRoomLatestMessage | null> => {
      try {
        const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
        const localRoomIdentifier = localRoomIdentifierForStorage(
          storage,
          roomIdentifier,
        );
        const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
          storage,
          roomIdentifier,
        );
        const page = storage.effectiveMode === "local"
          ? await getLatestLocalChatMessages(localRoomIdentifier, {
              limit: 1,
              readerKey: await resolveLocalThreadReaderKey(),
            })
          : await apiFetch<{
              messages?: RoomMessagePayload[];
            }>(
              `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages?limit=1&before=latest`,
            );
        const latest = page.messages?.at(-1) || null;
        return {
          roomIdentifier,
          latestMessageId: latest?.id || null,
          latestMessageAt: latest?.timestamp || null,
        };
      } catch {
        return null;
      }
    }),
  );

  return results.filter((result): result is DesktopRoomLatestMessage => Boolean(result));
}

export { readChatStorageSettings, setChatStorageMode, setRoomStorageMode };

export function resolveLocalCloudPublishAuthority(input: {
  source: string | null | undefined;
  publisherAgentKey: string | null;
  publisherSessionId: string | null;
  localControlAuthorized: boolean | null | undefined;
  cloudRoomIdentifier: string;
  publisherSession: {
    session_id: string;
    session_token?: string;
    agent_key?: string | null;
    room_id: string;
  } | null;
}): "worker" | "human" | null {
  if (
    input.source === "agent"
    && input.publisherSessionId
    && input.publisherAgentKey
    && input.publisherSession?.session_id === input.publisherSessionId
    && Boolean(input.publisherSession.session_token)
    && input.publisherSession.agent_key === input.publisherAgentKey
    && input.publisherSession.room_id === input.cloudRoomIdentifier
  ) {
    return "worker";
  }
  if (
    input.source === "browser"
    && input.localControlAuthorized === true
    && !input.publisherAgentKey
    && !input.publisherSessionId
  ) {
    return "human";
  }
  return null;
}

type CloudSyncWorkerSession = Pick<
  StoredAgentSessionState,
  "session_id" | "session_token" | "agent_key" | "room_id"
>;

async function registerLocalPublisherForCloudSync(
  cloudRoomIdentifier: string,
  localSession: StoredAgentSessionState,
  publisherAgentKey: string,
): Promise<CloudSyncWorkerSession> {
  if (
    localSession.session_kind !== "worker"
    || localSession.ended_at
    || localSession.agent_key !== publisherAgentKey
  ) {
    throw new Error("Local publisher session is no longer authoritative.");
  }
  const created = await apiFetch<{
    session_id?: string;
    session_token?: string;
    agent_key?: string | null;
    room_id?: string;
  }>(`/rooms/${encodeURIComponent(cloudRoomIdentifier)}/agent-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actor_key: publisherAgentKey,
      actor_label: localSession.actor_label || publisherAgentKey,
      display_name: localSession.display_name || localSession.actor_label || publisherAgentKey,
      ide_label: localSession.ide_label || "Agent",
      session_kind: "worker",
      runtime: localSession.runtime || "local-sync",
      repo_branch: localSession.repo_branch || null,
    }),
  });
  const sessionId = created.session_id?.trim() || "";
  const sessionToken = created.session_token?.trim() || "";
  if (
    !sessionId
    || !sessionToken
    || created.agent_key !== publisherAgentKey
    || created.room_id !== cloudRoomIdentifier
  ) {
    throw new Error("Cloud publisher registration returned mismatched authority.");
  }
  return {
    session_id: sessionId,
    session_token: sessionToken,
    agent_key: publisherAgentKey,
    room_id: cloudRoomIdentifier,
  };
}

async function disconnectCloudSyncWorkerSession(
  cloudRoomIdentifier: string,
  session: CloudSyncWorkerSession,
): Promise<void> {
  await apiFetch(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/agent-sessions/${encodeURIComponent(session.session_id)}/disconnect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_session_id: session.session_id,
        agent_session_token: session.session_token,
      }),
    },
  );
}

export async function syncDesktopLocalChatRoom(
  roomIdentifier: string,
): Promise<DesktopLocalChatSyncResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before syncing local chat.");
  }
  const localRoom = await getLocalRoom(trimmedRoomIdentifier)
    || await getLocalRoomByCloudRoom(trimmedRoomIdentifier);
  if (!localRoom) {
    throw new Error("Only local rooms can be published.");
  }
  const localRoomIdentifier = localRoom.roomIdentifier;
  const cloudRoomIdentifier = await ensureLocalRoomPublishTarget(
    localRoomIdentifier,
  );

  const localMessages = await claimUnsyncedLocalChatMessages(localRoomIdentifier);
  const cloudIdsByLocalId = new Map<string, string>();
  const cloudPublisherByLocalSessionId = new Map<string, CloudSyncWorkerSession>();
  let syncedCount = 0;
  let skippedCount = 0;

  try {
  for (const localMessage of localMessages) {
    const publisherSessionId = localMessage.agent_identity?.agent_session_id?.trim() || null;
    const publisherAgentKey = localMessage.agent_identity?.agent_key?.trim() || null;
    const publisherSession = publisherSessionId
      ? getStoredAgentSession(publisherSessionId)
      : null;
    let effectivePublisherSessionId = publisherSessionId;
    let effectivePublisherSession: CloudSyncWorkerSession | StoredAgentSessionState | null =
      publisherSession;
    if (
      localMessage.source === "agent"
      && publisherSessionId
      && publisherAgentKey
      && publisherSession?.room_id === localRoomIdentifier
      && publisherSession.agent_key === publisherAgentKey
      && publisherSession.session_kind === "worker"
      && !publisherSession.ended_at
    ) {
      let cloudPublisher = cloudPublisherByLocalSessionId.get(publisherSessionId);
      if (!cloudPublisher) {
        try {
          cloudPublisher = await registerLocalPublisherForCloudSync(
            cloudRoomIdentifier,
            publisherSession,
            publisherAgentKey,
          );
          cloudPublisherByLocalSessionId.set(publisherSessionId, cloudPublisher);
        } catch {
          skippedCount += 1;
          continue;
        }
      }
      effectivePublisherSession = cloudPublisher;
      effectivePublisherSessionId = cloudPublisher.session_id;
    }
    const publishAuthority = resolveLocalCloudPublishAuthority({
      source: localMessage.source,
      publisherAgentKey,
      publisherSessionId: effectivePublisherSessionId,
      localControlAuthorized: localMessage.local_control_authorized,
      cloudRoomIdentifier,
      publisherSession: effectivePublisherSession,
    });
    const publishAsWorker = publishAuthority === "worker";
    const publishAsHuman = publishAuthority === "human";
    if (!publishAsWorker && !publishAsHuman) {
      // Never promote agent/imported/ambiguous provenance into an owner-human
      // cloud write. The durable claim expires and can be retried if the exact
      // worker session becomes available again.
      skippedCount += 1;
      continue;
    }
    const replyToCloudId = localMessage.reply_to?.id
      ? cloudIdsByLocalId.get(localMessage.reply_to.id) ||
        await getSyncedCloudMessageId({
          roomId: localRoomIdentifier,
          localMessageId: localMessage.reply_to.id,
        })
      : null;
    if (localMessage.reply_to?.id && !replyToCloudId) {
      skippedCount += 1;
      continue;
    }
    const localThreadRootId = localMessage.thread_root_id || null;
    const threadRootCloudId =
      localThreadRootId && localThreadRootId !== localMessage.id
        ? cloudIdsByLocalId.get(localThreadRootId) ??
          (await getSyncedCloudMessageId({
            roomId: localRoomIdentifier,
            localMessageId: localThreadRootId,
          }))
        : null;
    if (localThreadRootId && localThreadRootId !== localMessage.id && !threadRootCloudId) {
      skippedCount += 1;
      continue;
    }
    let attachments: Array<{ upload_id: string }> = [];
    try {
      attachments = await Promise.all(
        (localMessage.attachments || []).map((attachment) =>
          publishLocalAttachmentPayload(cloudRoomIdentifier, attachment),
        ),
      );
    } catch {
      skippedCount += 1;
      continue;
    }

    const cloudMessage = await apiFetch<RoomMessagePayload>(
      `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(publishAsHuman ? { "X-LetAgents-Desktop-Client": "1" } : {}),
        },
        body: JSON.stringify({
          sender: localMessage.sender,
          text: localMessage.text,
          reply_to: replyToCloudId,
          thread_root_id: threadRootCloudId,
          attachments,
          client_message_id: localMessage.sync_key,
          ...(publishAsWorker && effectivePublisherSession ? {
            agent_session_id: effectivePublisherSession.session_id,
            agent_session_token: effectivePublisherSession.session_token,
          } : {}),
        }),
      },
    );

    if (cloudMessage.id) {
      cloudIdsByLocalId.set(localMessage.id, cloudMessage.id);
      await markLocalChatMessageSynced({
        roomId: localRoomIdentifier,
        localMessageId: localMessage.id,
        cloudMessageId: cloudMessage.id,
      });
      syncedCount += 1;
    } else {
      skippedCount += 1;
    }
  }
  } finally {
    await Promise.allSettled([...cloudPublisherByLocalSessionId.values()].map((session) =>
      disconnectCloudSyncWorkerSession(cloudRoomIdentifier, session)));
  }

  const taskResult = await syncLocalRoomTasks({
    localRoomIdentifier,
    cloudRoomIdentifier,
  });

  return {
    roomIdentifier: trimmedRoomIdentifier,
    cloudRoomIdentifier,
    syncedCount,
    skippedCount,
    syncedTaskCount: taskResult.syncedTaskCount,
    skippedTaskCount: taskResult.skippedTaskCount,
  };
}

async function ensureLocalRoomPublishTarget(
  roomIdentifier: string,
): Promise<string> {
  const localRoom = await getLocalRoom(roomIdentifier);
  if (localRoom?.cloudRoomIdentifier) {
    return localRoom.cloudRoomIdentifier;
  }
  if (!localRoom) {
    throw new Error("Only local rooms can be published.");
  }
  assertLocalRoomPublishable(localRoom);

  const createdRoom = await apiFetch<{ id?: string; room_id?: string }>(
    "/projects",
    { method: "POST" },
  );
  const cloudRoomIdentifier = createdRoom.room_id || createdRoom.id;
  if (!cloudRoomIdentifier) {
    throw new Error("Cloud room could not be created for publishing.");
  }
  await linkLocalRoomToCloud({
    roomIdentifier,
    cloudRoomIdentifier,
  });
  return cloudRoomIdentifier;
}

const taskStatusTransitions: Record<string, string[]> = {
  proposed: ["accepted", "cancelled"],
  accepted: ["assigned", "cancelled"],
  assigned: ["in_progress", "in_review", "cancelled"],
  in_progress: ["blocked", "in_review", "done", "cancelled"],
  blocked: ["in_progress", "in_review", "cancelled"],
  in_review: ["merged", "in_progress", "blocked", "done", "cancelled"],
  merged: ["done", "accepted"],
  done: ["accepted"],
  cancelled: ["accepted"],
};

function taskStatusPath(fromStatus: string, toStatus: string): string[] {
  if (!toStatus || fromStatus === toStatus) return [];
  const queue: Array<{ status: string; path: string[] }> = [
    { status: fromStatus || "proposed", path: [] },
  ];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.status)) continue;
    seen.add(current.status);
    for (const next of taskStatusTransitions[current.status] || []) {
      const path = [...current.path, next];
      if (next === toStatus) return path;
      queue.push({ status: next, path });
    }
  }
  return [];
}

function buildTaskPublishPatches(
  task: DesktopTaskSummary,
  cloudStatus: string,
): Record<string, unknown>[] {
  const patches: Record<string, unknown>[] = [];
  const targetStatus = task.status || "proposed";
  const assignee = task.assignee || task.createdBy || "human";
  const statusPath = taskStatusPath(cloudStatus || "proposed", targetStatus);

  for (const nextStatus of statusPath) {
    const patch: Record<string, unknown> = { status: nextStatus };
    if (nextStatus === "assigned") {
      patch.assignee = assignee;
      patch.assignee_agent_key = task.assigneeAgentKey || null;
    }
    patches.push(patch);
  }

  const finalPatch: Record<string, unknown> = {};
  if (task.assignee) finalPatch.assignee = task.assignee;
  if (task.assigneeAgentKey) finalPatch.assignee_agent_key = task.assigneeAgentKey;
  if (task.prUrl) finalPatch.pr_url = task.prUrl;
  if (task.workflowArtifacts?.length) {
    finalPatch.workflow_artifacts = task.workflowArtifacts;
  }
  if (Object.keys(finalPatch).length > 0) {
    patches.push(finalPatch);
  }
  return patches;
}

function extractCloudTask(
  response: { task?: { id?: string; status?: string }; id?: string; status?: string },
): { id: string | null; status: string | null } {
  return {
    id: response.task?.id || response.id || null,
    status: response.task?.status || response.status || null,
  };
}

async function fetchCloudTaskStatus(
  cloudRoomIdentifier: string,
  cloudTaskId: string,
): Promise<string | null> {
  const response = await apiFetch<{
    task?: { status?: string };
    status?: string;
  }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks/${encodeURIComponent(cloudTaskId)}`,
  );
  return response.task?.status || response.status || null;
}

async function patchCloudTask(
  cloudRoomIdentifier: string,
  cloudTaskId: string,
  patch: Record<string, unknown>,
): Promise<{ id: string | null; status: string | null }> {
  const response = await apiFetch<{
    task?: { id?: string; status?: string };
    id?: string;
    status?: string;
  }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks/${encodeURIComponent(cloudTaskId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        ...patch,
        desktop_human_client: true,
      }),
    },
  );
  return extractCloudTask(response);
}

async function syncLocalRoomTasks(input: {
  localRoomIdentifier: string;
  cloudRoomIdentifier: string;
}): Promise<{ syncedTaskCount: number; skippedTaskCount: number }> {
  const localTasks = await claimLocalTasksForPublish(input.localRoomIdentifier);
  let syncedTaskCount = 0;
  let skippedTaskCount = 0;

  for (const task of localTasks) {
    try {
      const cloudTaskId = await getLocalTaskCloudId({
        roomId: input.localRoomIdentifier,
        taskId: task.id,
      });
      const clientTaskId = `local-task:${input.localRoomIdentifier}:${task.id}`;
      const createBody = {
        title: task.title,
        description: task.description,
        created_by: task.createdBy || "human",
        source_message_id: clientTaskId,
        desktop_human_client: true,
        client_task_id: clientTaskId,
      };
      let syncedCloudTaskId = cloudTaskId;
      let cloudStatus: string | null = null;
      if (!syncedCloudTaskId) {
        const response = await apiFetch<{
          task?: { id?: string; status?: string };
          id?: string;
          status?: string;
        }>(
          `/rooms/${encodeURIComponent(input.cloudRoomIdentifier)}/tasks`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-LetAgents-Desktop-Client": "1",
            },
            body: JSON.stringify(createBody),
          },
        );
        const cloudTask = extractCloudTask(response);
        syncedCloudTaskId = cloudTask.id;
        cloudStatus = cloudTask.status || "proposed";
        if (syncedCloudTaskId) {
          await rememberLocalTaskCloudId({
            roomId: input.localRoomIdentifier,
            taskId: task.id,
            cloudTaskId: syncedCloudTaskId,
          });
        }
      } else {
        cloudStatus = await fetchCloudTaskStatus(
          input.cloudRoomIdentifier,
          syncedCloudTaskId,
        );
      }
      if (!syncedCloudTaskId) {
        skippedTaskCount += 1;
        await releaseLocalTaskPublishClaim({
          roomId: input.localRoomIdentifier,
          taskId: task.id,
        });
        continue;
      }
      let latestCloudStatus = cloudStatus || "proposed";
      for (const patch of buildTaskPublishPatches(task, latestCloudStatus)) {
        const patched = await patchCloudTask(
          input.cloudRoomIdentifier,
          syncedCloudTaskId,
          patch,
        );
        latestCloudStatus = patched.status || latestCloudStatus;
      }
      await markLocalTaskSynced({
        roomId: input.localRoomIdentifier,
        taskId: task.id,
        cloudTaskId: syncedCloudTaskId,
      });
      syncedTaskCount += 1;
    } catch {
      skippedTaskCount += 1;
      await releaseLocalTaskPublishClaim({
        roomId: input.localRoomIdentifier,
        taskId: task.id,
      });
    }
  }

  return { syncedTaskCount, skippedTaskCount };
}

type MessageInfoPayload = {
  message?: {
    id?: string; sender?: string; text_preview?: string; timestamp?: string;
    thread_root_id?: string; reply_to_id?: string | null;
  };
  seen_by_people?: Array<{ name?: string; avatar_url?: string | null; seen_at?: string }>;
  agents_asked?: Array<{
    receipt_id?: string; agent_key?: string; actor_label?: string;
    activation_reason_label?: string; receipt_state?: string; observed?: boolean;
    reply_message_id?: string | null;
  }>;
  also_observed?: Array<{ agent_key?: string; display_name?: string }>;
  summary_counts?: { seen_count?: number; asked_count?: number; reply_count?: number; observed_count?: number };
};

export function mapDesktopMessageInfoPayload(payload: MessageInfoPayload): DesktopMessageInfo | null {
  const message = payload.message;
  if (!message?.id || !message.sender || !message.timestamp) return null;
  return {
    message: {
      id: message.id,
      sender: message.sender,
      textPreview: message.text_preview ?? "",
      timestamp: message.timestamp,
      threadRootId: message.thread_root_id ?? message.id,
      replyToId: message.reply_to_id ?? null,
    },
    seenByPeople: (payload.seen_by_people ?? []).flatMap((person) =>
      person.name && person.seen_at
        ? [{ name: person.name, avatarUrl: person.avatar_url ?? null, seenAt: person.seen_at }]
        : []),
    agentsAsked: (payload.agents_asked ?? []).flatMap((agent) =>
      agent.receipt_id && agent.agent_key && agent.receipt_state
        ? [{
          receiptId: agent.receipt_id,
          agentKey: agent.agent_key,
          actorLabel: agent.actor_label || agent.agent_key,
          activationReasonLabel: agent.activation_reason_label || "",
          receiptState: agent.receipt_state,
          observed: agent.observed === true,
          replyMessageId: agent.reply_message_id ?? null,
        }]
        : []),
    alsoObserved: (payload.also_observed ?? []).flatMap((agent) =>
      agent.agent_key
        ? [{ agentKey: agent.agent_key, displayName: agent.display_name || agent.agent_key }]
        : []),
    summaryCounts: {
      seenCount: payload.summary_counts?.seen_count ?? 0,
      askedCount: payload.summary_counts?.asked_count ?? 0,
      replyCount: payload.summary_counts?.reply_count ?? 0,
      observedCount: payload.summary_counts?.observed_count ?? 0,
    },
  };
}

/**
 * Message info is cloud truth. Local-only rooms return null and the surface
 * shows its local-room copy instead of fabricating receipts.
 */
export async function getDesktopRoomMessageInfo(
  roomIdentifier: string,
  messageId: string,
): Promise<DesktopMessageInfo | null> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedMessageId = messageId.trim();
  if (!trimmedRoomIdentifier || !parsePositivePgIntegerScopedId(trimmedMessageId, "msg")) return null;
  if (isDesktopSmokeCheck()) return null;

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") return null;

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(storage, trimmedRoomIdentifier);
  const payload = await apiFetch<MessageInfoPayload>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages/${encodeURIComponent(trimmedMessageId)}/info`,
  );
  return mapDesktopMessageInfoPayload(payload);
}
