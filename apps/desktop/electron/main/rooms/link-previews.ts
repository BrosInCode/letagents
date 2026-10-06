import { parseLinkPreviewReferences, type LinkPreviewReference, type MessageLinkPreviewsResponse } from "../../../../../shared/message-link-previews.mjs";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

export async function getDesktopMessageLinkPreviews(identifier: string, input: LinkPreviewReference[]): Promise<MessageLinkPreviewsResponse> {
  const references = parseLinkPreviewReferences(input);
  if (!references) throw new Error("Choose at most 50 pull requests or issues.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") return { room_id: identifier, previews: [], available: false };
  const room = cloudRoomIdentifierForStorage(storage, identifier);
  return apiFetch(`/rooms/${encodeURIComponent(room)}/messages/link-previews`, {
    method: "POST", body: JSON.stringify({ references }),
  });
}
