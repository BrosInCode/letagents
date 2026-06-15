import type {
  DesktopLocalChatSyncResult,
  DesktopRoomLatestMessage,
  DesktopRoomMessagesPage,
  DesktopSendRoomMessageResult,
} from "../../ipc-types.js";
import { apiFetch, readStoredAuth } from "../auth.js";
import {
  addLocalChatMessage,
  claimUnsyncedLocalChatMessages,
  getLatestLocalChatMessages,
  getLocalChatMessagesBefore,
  getSyncedCloudMessageId,
  markLocalChatMessageSynced,
} from "./messages/local-store.js";
import {
  isLocalChatStorageEnabled,
  readChatStorageSettings,
  setChatStorageMode,
} from "../chat-storage/settings.js";
import { roomMessageHistoryPageSize } from "../paths.js";
import { desktopSmokeRoomSnapshot, isDesktopSmokeCheck } from "../smoke.js";
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
  if (await isLocalChatStorageEnabled()) {
    if (attachments.length > 0) {
      throw new Error("Local chat storage does not support attachments yet.");
    }
    const message = await addLocalChatMessage(trimmedRoomIdentifier, {
      sender,
      text: trimmedText,
      reply_to: replyTo || null,
      source: "browser",
    });
    return {
      message: mapRoomMessagePayload(message),
    };
  }

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

  if (await isLocalChatStorageEnabled()) {
    const page = await getLocalChatMessagesBefore(
      trimmedRoomIdentifier,
      trimmedBeforeMessageId,
      { limit },
    );
    return {
      messages: page.messages.map(mapRoomMessagePayload),
      hasOlder: page.has_more,
    };
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

  const localChatStorage = await isLocalChatStorageEnabled();
  const results = await Promise.all(
    identifiers.map(async (roomIdentifier): Promise<DesktopRoomLatestMessage | null> => {
      try {
        const page = localChatStorage
          ? await getLatestLocalChatMessages(roomIdentifier, { limit: 1 })
          : await apiFetch<{
              messages?: RoomMessagePayload[];
            }>(
              `/rooms/${encodeURIComponent(roomIdentifier)}/messages?limit=1&before=latest`,
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

export { readChatStorageSettings, setChatStorageMode };

export async function syncDesktopLocalChatRoom(
  roomIdentifier: string,
): Promise<DesktopLocalChatSyncResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before syncing local chat.");
  }

  const localMessages = await claimUnsyncedLocalChatMessages(trimmedRoomIdentifier);
  const cloudIdsByLocalId = new Map<string, string>();
  let syncedCount = 0;
  let skippedCount = 0;

  for (const localMessage of localMessages) {
    if (localMessage.attachments?.length) {
      skippedCount += 1;
      continue;
    }
    const replyToCloudId = localMessage.reply_to?.id
      ? cloudIdsByLocalId.get(localMessage.reply_to.id) ||
        await getSyncedCloudMessageId({
          roomId: trimmedRoomIdentifier,
          localMessageId: localMessage.reply_to.id,
        })
      : null;
    if (localMessage.reply_to?.id && !replyToCloudId) {
      skippedCount += 1;
      continue;
    }

    const cloudMessage = await apiFetch<RoomMessagePayload>(
      `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-LetAgents-Desktop-Client": "1",
        },
        body: JSON.stringify({
          sender: localMessage.sender,
          text: localMessage.text,
          reply_to: replyToCloudId,
          client_message_id: localMessage.sync_key,
        }),
      },
    );

    if (cloudMessage.id) {
      cloudIdsByLocalId.set(localMessage.id, cloudMessage.id);
      await markLocalChatMessageSynced({
        roomId: trimmedRoomIdentifier,
        localMessageId: localMessage.id,
        cloudMessageId: cloudMessage.id,
      });
      syncedCount += 1;
    } else {
      skippedCount += 1;
    }
  }

  return {
    roomIdentifier: trimmedRoomIdentifier,
    syncedCount,
    skippedCount,
  };
}
