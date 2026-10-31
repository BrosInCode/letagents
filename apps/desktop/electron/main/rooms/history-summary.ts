import type { RoomHistorySummarySetting } from "../../../../../shared/room-history-summary.mjs";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

async function settingPath(identifier: string): Promise<string> {
  if (!identifier?.trim()) throw new Error("Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") throw new Error("History summaries require a cloud room.");
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}/history-summary/setting`;
}

export async function getDesktopHistorySummarySetting(identifier: string): Promise<RoomHistorySummarySetting> {
  return apiFetch<RoomHistorySummarySetting>(await settingPath(identifier));
}

export async function setDesktopHistorySummarySetting(identifier: string, enabled: boolean): Promise<RoomHistorySummarySetting> {
  if (typeof enabled !== "boolean") throw new Error("Choose whether history summaries are on.");
  return apiFetch<RoomHistorySummarySetting>(await settingPath(identifier), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
  });
}
