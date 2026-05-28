import type {
  DesktopRoomMessagesPage,
  DesktopSendRoomMessageResult,
} from "../../ipc-types.js";
import { apiFetch, readStoredAuth } from "../auth.js";
import { roomMessageHistoryPageSize } from "../paths.js";
import {
  mapRoomMessagePayload,
  type RoomMessagePayload,
} from "./messages/mappers.js";

export { mapRoomMessagePayload, type RoomMessagePayload };

export async function sendDesktopRoomMessage(
  roomIdentifier: string,
  text: string,
  replyTo?: string | null,
  attachments: Array<{ upload_id: string }> = [],
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
  const message = await apiFetch<RoomMessagePayload>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        sender,
        text: trimmedText,
        reply_to: replyTo || null,
        attachments,
      }),
    },
  );

  return {
    message: mapRoomMessagePayload(message),
  };
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

  const page = await apiFetch<{
    messages?: RoomMessagePayload[];
    has_older?: boolean;
    has_more?: boolean;
  }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/messages?limit=${encodeURIComponent(String(limit))}&before=${encodeURIComponent(trimmedBeforeMessageId)}`,
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
