import type { RoomAgentReplyOrderSetting } from "../../../../../shared/room-settings.mjs";
import type { DesktopReplyOrderSettings } from "../../ipc-types/api.js";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

async function replyOrderPath(identifier: string): Promise<string> {
  if (!identifier?.trim()) throw new Error("Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") throw new Error("Answering in turns requires a cloud room.");
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}/agent-reply-order`;
}

// The room's reply order is off ("parallel") unless an admin turned it on;
// the switch shows only that, not whether the default or a choice applies.
function toSettings(response: RoomAgentReplyOrderSetting): DesktopReplyOrderSettings {
  return { enabled: response.order === "sequential", can_manage: response.can_manage === true };
}

export async function getDesktopReplyOrder(identifier: string): Promise<DesktopReplyOrderSettings> {
  return toSettings(await apiFetch<RoomAgentReplyOrderSetting>(await replyOrderPath(identifier)));
}

export async function setDesktopReplyOrder(identifier: string, enabled: boolean): Promise<DesktopReplyOrderSettings> {
  if (typeof enabled !== "boolean") throw new Error("Choose whether agents answer in turns.");
  return toSettings(await apiFetch<RoomAgentReplyOrderSetting>(await replyOrderPath(identifier), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: enabled ? "sequential" : "parallel" }),
  }));
}
