import { apiFetch } from "../../auth.js";
import { isLocalChatStorageEnabled } from "../../chat-storage/settings.js";
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
): Promise<RoomSnapshotData> {
  const localChatStorage = await isLocalChatStorageEnabled();
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
      `/rooms/${encodeURIComponent(roomIdentifier)}/focus-rooms`,
    ).catch(() => ({ focus_rooms: [] })),
    apiFetch<RoomSnapshotData["tasksData"]>(
      `/rooms/${encodeURIComponent(roomIdentifier)}/tasks`,
    ).catch(() => ({ tasks: [] })),
    apiFetch<ParticipantsResponse>(
      `/rooms/${encodeURIComponent(roomIdentifier)}/participants`,
    ).catch(() => ({ participants: [], hidden_count: 0 })),
    apiFetch<PresenceResponse>(
      `/rooms/${encodeURIComponent(roomIdentifier)}/presence?limit=100&scope=snapshot`,
    ).catch(() => ({ presence: [] })),
    apiFetch<ReasoningResponse>(
      `/rooms/${encodeURIComponent(roomIdentifier)}/reasoning-sessions`,
    ).catch(() => ({ sessions: [], reasoning_sessions: [] })),
    apiFetch<ActivityHistoryResponse>(
      `/rooms/${encodeURIComponent(roomIdentifier)}/activity-history?page_size=50`,
    ).catch(() => ({ entries: [] })),
    localChatStorage
      ? getLatestLocalChatMessages(roomIdentifier, {
          limit: roomMessageHistoryPageSize,
        }).then((page) => ({ messages: page.messages }))
      : apiFetch<MessagesResponse>(
          `/rooms/${encodeURIComponent(roomIdentifier)}/messages?limit=${roomMessageHistoryPageSize}&before=latest`,
        ),
    apiFetch<GitHubEventsResponse>(
      `/rooms/${encodeURIComponent(roomIdentifier)}/events?limit=100`,
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
