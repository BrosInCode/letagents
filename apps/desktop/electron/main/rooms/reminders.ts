import { apiFetch } from "../auth.js";
import type { DesktopMessageReminder, DesktopMessageRemindersPage } from "../../ipc-types/reminders.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";
export async function createDesktopMessageReminder(identifier: string, messageId: string, dueAt: string): Promise<{ reminder: DesktopMessageReminder }> {
  if (!identifier?.trim() || !/^msg_[1-9]\d*$/.test(messageId) || Number(messageId.slice(4)) > 2147483647 || !Number.isFinite(Date.parse(dueAt))) throw new Error("Choose a message and reminder time.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") throw new Error("Reminders require a cloud room.");
  const room = cloudRoomIdentifierForStorage(storage, identifier);
  return apiFetch(`/rooms/${encodeURIComponent(room)}/messages/${messageId}/reminders`, { method: "POST", body: JSON.stringify({ due_at: dueAt }) });
}
export function getDesktopMessageReminders(offset = 0): Promise<DesktopMessageRemindersPage> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error("Invalid reminder page.");
  return apiFetch(`/desktop/reminders?offset=${offset}`);
}
export function deleteDesktopMessageReminder(id: string): Promise<{ ok: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid reminder.");
  return apiFetch(`/desktop/reminders/${id}`, { method: "DELETE" });
}
