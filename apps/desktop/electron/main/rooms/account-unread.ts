import { randomUUID } from "node:crypto";

import type { DesktopAccountUnread } from "../../ipc-types/unread.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

type ServerRoomUnread = { room_id?: unknown; read_message_id?: unknown; unread_count?: unknown; github_unread_count?: unknown };

const countOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The account's read points and unread counts for every room it lists, in one
 * request. Null when the server is older and has no such route: the caller
 * then counts from room history as before.
 */
export async function getDesktopAccountUnread(): Promise<DesktopAccountUnread | null> {
  let data: { rooms?: unknown };
  try {
    data = await apiFetch<{ rooms?: unknown }>("/account/unread");
  } catch (error) {
    if (error instanceof DesktopApiError && error.status === 404) return null;
    throw error;
  }
  const rooms = Array.isArray(data.rooms) ? data.rooms as ServerRoomUnread[] : [];
  return {
    rooms: rooms.flatMap((room) => typeof room?.room_id === "string" && room.room_id ? [{
      roomId: room.room_id,
      readMessageId: typeof room.read_message_id === "string" ? room.read_message_id : null,
      unreadCount: countOrNull(room.unread_count),
      githubUnreadCount: countOrNull(room.github_unread_count),
    }] : []),
  };
}

/**
 * Tell the server this account read a cloud room from `fromMessageId` (or
 * only `messageId` itself) up to `messageId`, the way the web reports reads
 * (a timeline read range; the server also shows it as read receipts). Local
 * rooms have no server read state; nothing is sent for them.
 */
export async function reportDesktopRoomRead(roomIdentifier: string, messageId: string, fromMessageId?: string | null): Promise<void> {
  const id = /^msg_[1-9]\d*$/;
  if (!id.test(messageId)) return;
  const first = fromMessageId && id.test(fromMessageId) && Number(fromMessageId.slice(4)) <= Number(messageId.slice(4))
    ? fromMessageId : messageId;
  const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
  if (storage.effectiveMode === "local") return;
  const roomId = cloudRoomIdentifierForStorage(storage, roomIdentifier);
  await apiFetch(`/rooms/${encodeURIComponent(roomId)}/messages/read`, {
    method: "PUT",
    body: JSON.stringify({ ranges: [{
      scope_kind: "timeline",
      first_message_id: first,
      last_message_id: messageId,
      client_batch_id: `desktop-${randomUUID()}`,
    }] }),
  });
}
