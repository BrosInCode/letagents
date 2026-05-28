import { ref, type Ref } from "vue";
import type { DesktopAccountRoomEntry, DesktopRoomSnapshot } from "../../../electron/ipc-types";
import type { SidebarEntry } from "../components/desktop/types";
import {
  normalizeRoomIdentifier,
  rememberRecentRootRooms,
  type RecentRootRoom,
} from "../domain/sidebar-rooms";

interface OpenRoomOptions {
  rootPath?: string | null;
  meta?: string | null;
}

interface DesktopAccountRoomSettingsOptions {
  accountRooms: Ref<DesktopAccountRoomEntry[]>;
  activeEntry: Ref<SidebarEntry>;
  loading: Ref<boolean>;
  recentRootRooms: Ref<RecentRootRoom[]>;
  recentRootRoomsStorageKey: string;
  rootRoomSnapshot: Ref<DesktopRoomSnapshot | null>;
  selectedRootRoomIdentifier: Ref<string | null>;
  selectedSnapshot: Ref<DesktopRoomSnapshot | null>;
  settingsAccountRooms: Ref<DesktopAccountRoomEntry[]>;
  settingsEntry: SidebarEntry;
  openRoomSnapshot: (snapshot: DesktopRoomSnapshot, options?: OpenRoomOptions) => void;
  refresh: () => Promise<void>;
  refreshAccountRooms: () => Promise<void>;
}

export function useDesktopAccountRoomSettings(options: DesktopAccountRoomSettingsOptions) {
  const settingsFeedback = ref<{ message: string; state: "error" | "info" | "success" } | null>(null);
  const settingsRoomActionBusyKey = ref<string | null>(null);

  async function refreshSettings(): Promise<void> {
    settingsFeedback.value = { message: "Refreshing account rooms...", state: "info" };
    try {
      await options.refresh();
      settingsFeedback.value = { message: "Settings refreshed.", state: "success" };
    } catch (error) {
      settingsFeedback.value = {
        message: error instanceof Error ? error.message : "Settings could not refresh.",
        state: "error",
      };
    }
  }

  async function openAccountRoomFromSettings(room: DesktopAccountRoomEntry): Promise<void> {
    settingsFeedback.value = { message: `Opening ${room.displayName}...`, state: "info" };
    options.loading.value = true;
    try {
      const snapshot = await window.letagentsDesktop.room.getSnapshot(room.roomIdentifier);
      options.openRoomSnapshot(snapshot, { meta: room.role === "admin" ? "Admin" : "Account room" });
      settingsFeedback.value = null;
    } catch (error) {
      settingsFeedback.value = {
        message: error instanceof Error ? error.message : `Could not open ${room.displayName}.`,
        state: "error",
      };
    } finally {
      options.loading.value = false;
    }
  }

  async function leaveAccountRoom(room: DesktopAccountRoomEntry): Promise<void> {
    if (!window.confirm(`Leave ${room.displayName}? It will be removed from your account room list.`)) {
      return;
    }

    settingsRoomActionBusyKey.value = settingsRoomActionKey("leave", room);
    settingsFeedback.value = { message: `Leaving ${room.displayName}...`, state: "info" };
    try {
      await window.letagentsDesktop.room.leaveAccountRoom(room.roomIdentifier);
      forgetRecentRootRoom(room.roomIdentifier);
      await options.refreshAccountRooms();
      settingsFeedback.value = { message: `Left ${room.displayName}.`, state: "success" };
    } catch (error) {
      settingsFeedback.value = {
        message: error instanceof Error ? error.message : `Could not leave ${room.displayName}.`,
        state: "error",
      };
    } finally {
      settingsRoomActionBusyKey.value = null;
    }
  }

  async function toggleAccountRoomPin(room: DesktopAccountRoomEntry): Promise<void> {
    const nextPinned = !room.pinned;
    settingsRoomActionBusyKey.value = settingsRoomActionKey("pin", room);
    settingsFeedback.value = {
      message: nextPinned ? `Pinning ${room.displayName}...` : `Unpinning ${room.displayName}...`,
      state: "info",
    };
    try {
      await window.letagentsDesktop.room.updateAccountRoom(room.roomIdentifier, { pinned: nextPinned });
      await options.refreshAccountRooms();
      settingsFeedback.value = {
        message: nextPinned ? `${room.displayName} pinned.` : `${room.displayName} unpinned.`,
        state: "success",
      };
    } catch (error) {
      settingsFeedback.value = {
        message: error instanceof Error ? error.message : `Could not update ${room.displayName}.`,
        state: "error",
      };
    } finally {
      settingsRoomActionBusyKey.value = null;
    }
  }

  async function restoreAccountRoom(room: DesktopAccountRoomEntry): Promise<void> {
    settingsRoomActionBusyKey.value = settingsRoomActionKey("restore", room);
    settingsFeedback.value = { message: `Restoring ${room.displayName}...`, state: "info" };
    try {
      await window.letagentsDesktop.room.updateAccountRoom(room.roomIdentifier, { archived: false });
      await options.refreshAccountRooms();
      settingsFeedback.value = { message: `${room.displayName} restored to your sidebar.`, state: "success" };
    } catch (error) {
      settingsFeedback.value = {
        message: error instanceof Error ? error.message : `Could not restore ${room.displayName}.`,
        state: "error",
      };
    } finally {
      settingsRoomActionBusyKey.value = null;
    }
  }

  async function deleteAccountRoom(room: DesktopAccountRoomEntry): Promise<void> {
    const confirmation = window.prompt(
      `Delete ${room.displayName}? This removes the room and its focus rooms for everyone.\n\nType the room identifier to confirm:`,
      ""
    );
    if (confirmation !== room.roomIdentifier) {
      return;
    }

    settingsRoomActionBusyKey.value = settingsRoomActionKey("delete", room);
    settingsFeedback.value = { message: `Deleting ${room.displayName}...`, state: "info" };
    try {
      await window.letagentsDesktop.room.deleteAccountRoom(room.roomIdentifier);
      forgetRecentRootRoom(room.roomIdentifier);
      options.accountRooms.value = options.accountRooms.value.filter(
        (entry) => normalizeRoomIdentifier(entry.roomIdentifier) !== normalizeRoomIdentifier(room.roomIdentifier)
      );
      options.settingsAccountRooms.value = options.settingsAccountRooms.value.filter(
        (entry) => normalizeRoomIdentifier(entry.roomIdentifier) !== normalizeRoomIdentifier(room.roomIdentifier)
      );

      if (normalizeRoomIdentifier(options.selectedRootRoomIdentifier.value) === normalizeRoomIdentifier(room.roomIdentifier)) {
        options.selectedRootRoomIdentifier.value = null;
        options.rootRoomSnapshot.value = null;
        options.selectedSnapshot.value = null;
        options.activeEntry.value = options.settingsEntry;
      }

      await options.refreshAccountRooms();
      settingsFeedback.value = { message: `Deleted ${room.displayName}.`, state: "success" };
    } catch (error) {
      settingsFeedback.value = {
        message: error instanceof Error ? error.message : `Could not delete ${room.displayName}.`,
        state: "error",
      };
    } finally {
      settingsRoomActionBusyKey.value = null;
    }
  }

  function settingsRoomActionKey(action: "delete" | "leave" | "pin" | "restore", room: DesktopAccountRoomEntry): string {
    return `${action}:${room.roomIdentifier}`;
  }

  function forgetRecentRootRoom(roomIdentifier: string): void {
    const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
    if (!normalizedRoomIdentifier) return;
    const nextRecentRooms = options.recentRootRooms.value.filter(
      (room) => normalizeRoomIdentifier(room.identifier) !== normalizedRoomIdentifier
    );
    options.recentRootRooms.value = nextRecentRooms;
    rememberRecentRootRooms(options.recentRootRoomsStorageKey, nextRecentRooms);
  }

  return {
    deleteAccountRoom,
    leaveAccountRoom,
    openAccountRoomFromSettings,
    refreshSettings,
    restoreAccountRoom,
    settingsFeedback,
    settingsRoomActionBusyKey,
    toggleAccountRoomPin,
  };
}
