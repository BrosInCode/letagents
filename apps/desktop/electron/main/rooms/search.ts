import { parseMessageSearchQuery } from "../../../../../shared/message-search.mjs";
import type { DesktopRoomMessageSearchPage } from "../../ipc-types/api.js";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";
import { mapCloudRoomMessagePayload, type RoomMessagePayload } from "./messages/mappers.js";

const MESSAGE_ID = /^msg_[1-9]\d*$/;

/** Search one cloud room's whole history. A room kept on this computer has no server history to search. */
export async function searchDesktopRoomMessages(
  identifier: string,
  query: string,
  beforeMessageId?: string | null,
): Promise<DesktopRoomMessageSearchPage> {
  if (!identifier?.trim()) throw new Error("Choose a room first.");
  const parsed = parseMessageSearchQuery(query);
  if (parsed.error) throw new Error("Type a longer or shorter search.");
  if (beforeMessageId != null && !MESSAGE_ID.test(beforeMessageId)) throw new Error("Choose a message first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") throw new Error("Searching earlier messages requires a cloud room.");

  const params = new URLSearchParams({ q: query.trim() });
  if (beforeMessageId) params.set("before", beforeMessageId);
  const response = await apiFetch<{
    terms?: unknown;
    messages?: RoomMessagePayload[];
    has_more?: boolean;
    next_before?: unknown;
  }>(`/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}/messages/search?${params}`);

  const nextBefore = typeof response.next_before === "string" && MESSAGE_ID.test(response.next_before)
    ? response.next_before
    : null;
  return {
    terms: Array.isArray(response.terms) ? response.terms.filter((term): term is string => typeof term === "string") : parsed.terms,
    messages: (Array.isArray(response.messages) ? response.messages : []).map(mapCloudRoomMessagePayload),
    has_more: Boolean(response.has_more) && nextBefore !== null,
    next_before: nextBefore,
  };
}
