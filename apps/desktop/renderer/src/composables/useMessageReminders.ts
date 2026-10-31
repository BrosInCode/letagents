import { reactive, ref } from "vue";
import type { DesktopMessageReminder } from "../../../electron/ipc-types/reminders.js";
import { desktopBridgeUpgradeMessage, desktopIpc } from "../ipc/index.js";
export const reminderAccount = ref<string | null>(null);
const state = reactive({ items: [] as DesktopMessageReminder[], nextOffset: null as number | null, loading: false, actionLoading: false, error: "", pending: "" });
let generation = 0;
let read = 0;
export function setReminderAccount(account: string | null): void {
  if (account === reminderAccount.value) return;
  reminderAccount.value = account; generation++; read++;
  Object.assign(state, { items: [], nextOffset: null, loading: false, actionLoading: false, error: "", pending: "" });
}
export async function refreshMessageReminders(more = false, ownAction = false): Promise<void> {
  if (!reminderAccount.value) return;
  const offset = more ? state.nextOffset : 0;
  if (offset === null) return;
  const ticket = ++read;
  state.actionLoading = ownAction || (state.loading && state.actionLoading);
  state.loading = true; state.error = "";
  try {
    if (!desktopIpc.room?.getMessageReminders) throw Error(desktopBridgeUpgradeMessage());
    const page = await desktopIpc.room.getMessageReminders(offset);
    if (ticket !== read) return;
    state.items = more ? [...state.items, ...page.reminders] : page.reminders;
    state.nextOffset = page.next_offset;
  } catch (error) { if (ticket === read) state.error = error instanceof Error ? error.message : "Reminders could not be loaded."; }
  finally { if (ticket === read) { state.loading = false; state.actionLoading = false; } }
}
export async function scheduleMessageReminder(room: string, message: string, dueAt: string): Promise<void> {
  const started = generation;
  if (!reminderAccount.value) throw Error("Sign in to set a reminder.");
  if (!desktopIpc.room?.createMessageReminder) throw Error(desktopBridgeUpgradeMessage());
  await desktopIpc.room.createMessageReminder(room, message, dueAt);
  if (started === generation) await refreshMessageReminders(false, true);
}
export async function removeMessageReminder(id: string): Promise<void> {
  const started = generation;
  state.pending = id; state.error = "";
  try {
    if (!reminderAccount.value || !desktopIpc.room?.deleteMessageReminder) throw Error(desktopBridgeUpgradeMessage());
    await desktopIpc.room.deleteMessageReminder(id);
    if (started === generation) await refreshMessageReminders(false, true);
  } catch (error) { if (started === generation) state.error = error instanceof Error ? error.message : "Reminder could not be removed."; }
  finally { if (started === generation) state.pending = ""; }
}
export function useMessageReminders() { return { state, account: reminderAccount, refresh: refreshMessageReminders, remove: removeMessageReminder }; }
