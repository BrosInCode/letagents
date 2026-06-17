import { apiFetch } from "../../auth.js";
import {
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "../local-store.js";
import { roomMessageHistoryPageSize } from "../../paths.js";
import type { GitHubEventsResponse } from "../events.js";
import { getLatestLocalChatMessages } from "../messages/local-store.js";
import type {
  ActivityHistoryResponse,
  FocusRoomsResponse,
  MessagesResponse,
  ParticipantsResponse,
  PresenceResponse,
  ReasoningResponse,
  RoomSnapshotData,
} from "./payloads.js";

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
    !options.forceCloudMessages && storage.effectiveMode === "local"
      ? getLatestLocalChatMessages(localRoomIdentifier, {
          limit: roomMessageHistoryPageSize,
        }).then((page) => ({ messages: page.messages }))
      : apiFetch<MessagesResponse>(
          `/rooms/${encodeURIComponent(apiRoomIdentifier)}/messages?limit=${roomMessageHistoryPageSize}&before=latest`,
        ).catch(() => ({ messages: [] })),
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
    messagesData,
    githubEventsData,
  };
}
