import type { DesktopConversationRoutingSettings } from "../../ipc-types/api.js";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

async function routingPath(identifier: string): Promise<string> {
  if (!identifier?.trim()) throw new Error("Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") throw new Error("Smart conversation routing requires a cloud room.");
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}/conversation-routing`;
}

export async function getDesktopConversationRouting(identifier: string): Promise<DesktopConversationRoutingSettings> {
  return apiFetch(await routingPath(identifier));
}

export async function setDesktopConversationRouting(identifier: string, enabled: boolean): Promise<DesktopConversationRoutingSettings> {
  if (typeof enabled !== "boolean") throw new Error("Choose whether routing is enabled.");
  return apiFetch(await routingPath(identifier), {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
  });
}
