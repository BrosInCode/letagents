import { isPinMessageId, type MessagePinsResponse, type MessagePinMutationResponse } from "../../../../../shared/message-pins.mjs";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

async function messagesPath(identifier: string): Promise<string | null> {
  if (!identifier?.trim()) throw new Error("Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  return storage.effectiveMode === "local" ? null
    : `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}/messages`;
}
export async function getDesktopMessagePins(identifier: string): Promise<MessagePinsResponse> {
  const path = await messagesPath(identifier);
  return path ? apiFetch<MessagePinsResponse>(`${path}/pins`)
    : { room_id: identifier, available: false, pins: [] };
}
export async function setDesktopMessagePin(identifier: string, messageId: string, pinned: boolean): Promise<MessagePinMutationResponse> {
  if (!isPinMessageId(messageId) || typeof pinned !== "boolean") throw new Error("Choose a message and pin action.");
  const path = await messagesPath(identifier);
  if (!path) throw new Error("Pins require a cloud room.");
  return apiFetch<MessagePinMutationResponse>(`${path}/${messageId}/pin`, { method: pinned ? "PUT" : "DELETE" });
}
