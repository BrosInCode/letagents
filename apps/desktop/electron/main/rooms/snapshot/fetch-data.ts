import { apiFetch } from "../../auth.js";
import {
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "../local-store.js";
import { roomMessageHistoryPageSize } from "../../paths.js";
import type { GitHubEventsResponse } from "../events.js";
import { getLatestLocalChatMessages } from "../messages/local-store.js";
import type { RoomMessagePayload } from "../messages/mappers.js";
import { resolveLocalThreadReaderKey } from "../messages/thread-reader.js";
import type {
  ActivityHistoryResponse,
  FocusRoomsResponse,
  MessagesResponse,
  ParticipantsResponse,
  PresenceResponse,
  ReasoningResponse,
  RoomSnapshotData,
} from "./payloads.js";

type ThreadPageResponse = {
  root?: RoomMessagePayload | null;
  replies?: RoomMessagePayload[];
  has_older?: boolean;
};

export async function fetchRoomSnapshotData(
  roomIdentifier: string,
  options: { forceCloudMessages?: boolean } = {},
): Promise<RoomSnapshotData> {
  const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
  const apiRoomIdentifier = cloudRoomIdentifierForStorage(storage, roomIdentifier);
  const localRoomIdentifier = localRoomIdentifierForStorage(storage, roomIdentifier);
  const [
    focusRoomsData,
    tasksData,
    participantsData,
    presenceData,
    reasoningData,
    activityHistoryData,
    roomArtifactsData,
    messagesData,
    githubEventsData,
  ] = await Promise.all([
    apiFetch<FocusRoomsResponse>(
      `/rooms/${encodeURIComponent(apiRoomIdentifier)}/focus-rooms`,
    ).catch(() => ({ focus_rooms: [] })),
    apiFetch<RoomSnapshotData["tasksData"]>(
      `/rooms/${encodeURIComponent(apiRoomIdentifier)}/tasks`,
    ).catch(() => ({ tasks: [] })),
    apiFetch<ParticipantsResponse>(
      `/rooms/${encodeURIComponent(apiRoomIdentifier)}/participants`,
    ).catch(() => ({ participants: [], hidden_count: 0 })),
    apiFetch<PresenceResponse>(
      `/rooms/${encodeURIComponent(apiRoomIdentifier)}/presence?limit=100&scope=snapshot`,
    ).catch(() => ({ presence: [] })),
    apiFetch<ReasoningResponse>(
      `/rooms/${encodeURIComponent(apiRoomIdentifier)}/reasoning-sessions`,
    ).catch(() => ({ sessions: [], reasoning_sessions: [] })),
    apiFetch<ActivityHistoryResponse>(
      `/rooms/${encodeURIComponent(apiRoomIdentifier)}/activity-history?page_size=50`,
    ).catch(() => ({ entries: [] })),
    apiFetch<RoomSnapshotData["roomArtifactsData"]>(
      `/rooms/${encodeURIComponent(apiRoomIdentifier)}/artifacts?limit=100`,
    ).catch(() => ({ artifacts: [] })),
    !options.forceCloudMessages && storage.effectiveMode === "local"
      ? getLatestLocalChatMessages(localRoomIdentifier, {
          limit: roomMessageHistoryPageSize,
          readerKey: await resolveLocalThreadReaderKey(),
        }).then((page) => ({ messages: page.messages }))
      : apiFetch<MessagesResponse>(
          `/rooms/${encodeURIComponent(apiRoomIdentifier)}/messages?limit=${roomMessageHistoryPageSize}&before=latest`,
        )
          .then((page) => expandMessagesWithThreadAncestors(apiRoomIdentifier, page.messages || []))
          .then((messages) => ({ messages }))
          .catch(() => ({ messages: [] })),
    apiFetch<GitHubEventsResponse>(
      `/rooms/${encodeURIComponent(apiRoomIdentifier)}/events?limit=100`,
    ).catch(() => null),
  ]);

  return {
    focusRoomsData,
    tasksData,
    participantsData,
    presenceData,
    reasoningData,
    activityHistoryData,
    roomArtifactsData,
    messagesData,
    githubEventsData,
  };
}

async function expandMessagesWithThreadAncestors(
  roomIdentifier: string,
  messages: RoomMessagePayload[],
): Promise<RoomMessagePayload[]> {
  const byId = new Map(messages.filter((message) => message.id).map((message) => [message.id, message]));
  const rootsToFetch = new Set<string>();
  for (const message of messages) {
    const rootId = message.thread?.root_message_id || message.thread_root_id || null;
    const replyToId = message.reply_to?.id || null;
    if (rootId && !byId.has(rootId)) rootsToFetch.add(rootId);
    if (replyToId && !byId.has(replyToId)) rootsToFetch.add(rootId || replyToId);
  }

  for (const rootId of rootsToFetch) {
    await fetchThreadUntilReferencesPresent(roomIdentifier, rootId, messages, byId);
  }

  return [...byId.values()].sort(
    (left, right) => Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""),
  );
}

async function fetchThreadUntilReferencesPresent(
  roomIdentifier: string,
  rootId: string,
  seedMessages: RoomMessagePayload[],
  byId: Map<string, RoomMessagePayload>,
): Promise<void> {
  let before: string | null = null;
  for (let pageCount = 0; pageCount < 20; pageCount += 1) {
    const params = new URLSearchParams({ limit: String(roomMessageHistoryPageSize) });
    if (before) params.set("before", before);
    const page = await apiFetch<ThreadPageResponse>(
      `/rooms/${encodeURIComponent(roomIdentifier)}/messages/${encodeURIComponent(rootId)}/thread?${params.toString()}`,
    ).catch(() => null);
    if (!page) return;
    for (const message of [page.root, ...(page.replies || [])]) {
      if (message?.id) byId.set(message.id, message);
    }
    if (threadReferencesPresent(rootId, seedMessages, byId) || !page.has_older) return;
    before = page.replies?.[0]?.id || null;
    if (!before) return;
  }
}

function threadReferencesPresent(
  rootId: string,
  seedMessages: RoomMessagePayload[],
  byId: Map<string, RoomMessagePayload>,
): boolean {
  return seedMessages.every((message) => {
    const messageRootId = message.thread?.root_message_id || message.thread_root_id || message.id;
    if (messageRootId !== rootId) return true;
    const replyToId = message.reply_to?.id || null;
    return byId.has(messageRootId) && (!replyToId || byId.has(replyToId));
  });
}
