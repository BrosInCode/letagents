import { watch } from "vue";
import type { DesktopAppAgentRunInput, DesktopAppAgentRunResult } from "../../../../electron/ipc-types";
import { settingsEntry } from "../../domain/desktop-navigation";
import { safeUserVisibleErrorDetail } from "../../domain/user-visible-error";
import { normalizeRoomIdentifier, rememberRecentRootRooms } from "../../domain/sidebar-rooms";
import { appAgentArchivedRoomIdentifiers } from "../../domain/app-agent";
import type { AttentionNavigationIntent } from "../../components/desktop/content/room-shell/types";
import { desktopIpc } from "../../ipc/index.js";
import { roomAliasSet, roomMatchesAliases } from "../../domain/app-room-aliases";
import type { AppContextOf } from "./context";

/** Leaving archived or hidden rooms, and opening rooms by identifier. */
export function useAppArchivedRooms(context: unknown) {
  const app = context as AppContextOf<
      "useAppNavigation"
    | "useAppRoomContext"
    | "useAppRoomData"
    | "useAppState"
  >;
  const {
    accountRooms, attentionIntent, loading, notificationRevealMessageId, recentRootRooms,
    recentRootRoomsStorageKey, rootRoomSnapshot, selectedRootRoomIdentifier, selectedSnapshot,
    settingsAccountRooms,
  } = app;
  async function leaveArchivedActiveRoomAfterAppAgent(
    result: DesktopAppAgentRunResult,
    input: DesktopAppAgentRunInput,
    options: { deferNavigation?: boolean } = {},
  ): Promise<boolean> {
    const archivedAliases = new Set(appAgentArchivedRoomIdentifiers(result));
    if (!archivedAliases.size) return false;
    forgetRecentRootRoomAliases(archivedAliases);

    const activeAliases = currentActiveRoomAliases(input);
    if (![...archivedAliases].some((alias) => activeAliases.has(alias))) {
      return false;
    }

    for (const alias of activeAliases) {
      archivedAliases.add(alias);
    }
    forgetRecentRootRoomAliases(archivedAliases);
    if (options.deferNavigation) {
      rootRoomSnapshot.value = null;
      app.clearSelectedSnapshotCache();
      selectedSnapshot.value = null;
      selectedRootRoomIdentifier.value = null;
      return true;
    }
    await leaveArchivedActiveRoom(archivedAliases);
    return true;
  }

  async function leaveArchivedRoomIfActive(
    roomIdentifier: string,
    displayName?: string | null,
  ): Promise<boolean> {
    const archivedAliases = roomAliasSet([roomIdentifier, displayName]);
    if (!archivedAliases.size) return false;
    forgetRecentRootRoomAliases(archivedAliases);
    const activeAliases = currentActiveRoomAliases();
    if (![...archivedAliases].some((alias) => activeAliases.has(alias))) {
      return false;
    }
    for (const alias of activeAliases) {
      archivedAliases.add(alias);
    }
    forgetRecentRootRoomAliases(archivedAliases);
    await leaveArchivedActiveRoom(archivedAliases);
    return true;
  }

  async function leaveArchivedSelectedRoomFromSettingsList(): Promise<boolean> {
    if (app.activeEntry.value.type !== "room") return false;
    const activeAliases = currentActiveRoomAliases();
    const archivedRoom = settingsAccountRooms.value.find(
      (room) => room.archived && roomMatchesAliases(room, activeAliases),
    ) || null;
    if (!archivedRoom) return false;

    const archivedAliases = roomAliasSet([
      archivedRoom.roomIdentifier,
      archivedRoom.displayName,
      archivedRoom.name,
    ]);
    for (const alias of activeAliases) {
      archivedAliases.add(alias);
    }
    forgetRecentRootRoomAliases(archivedAliases);
    await leaveArchivedActiveRoom(archivedAliases);
    return true;
  }

  async function leaveArchivedActiveRoom(archivedAliases: Set<string>): Promise<void> {
    const nextRoom = accountRooms.value.find(
      (room) => !room.archived && !roomMatchesAliases(room, archivedAliases),
    ) || null;
    if (nextRoom) {
      await openRoomFromAppAgent(nextRoom.roomIdentifier);
      return;
    }

    rootRoomSnapshot.value = null;
    app.clearSelectedSnapshotCache();
    selectedSnapshot.value = null;
    selectedRootRoomIdentifier.value = null;
    app.activeEntry.value = settingsEntry;
  }

  function currentActiveRoomAliases(input?: Partial<DesktopAppAgentRunInput>): Set<string> {
    return roomAliasSet([
      input?.activeRoomIdentifier,
      input?.activeRoomDisplayName,
      app.selectedRoomIdentifier.value,
      selectedRootRoomIdentifier.value,
      app.selectedRoomInfo.value.identifier,
      app.selectedRoomInfo.value.displayName,
      app.selectedRoomInfo.value.name,
      app.selectedRoomInfo.value.code,
      selectedSnapshot.value?.roomIdentifier,
      selectedSnapshot.value?.access.roomIdentifier,
      selectedSnapshot.value?.access.code,
      selectedSnapshot.value?.room?.identifier,
      selectedSnapshot.value?.room?.displayName,
      selectedSnapshot.value?.room?.name,
      selectedSnapshot.value?.room?.code,
      rootRoomSnapshot.value?.roomIdentifier,
      rootRoomSnapshot.value?.access.roomIdentifier,
      rootRoomSnapshot.value?.access.code,
      rootRoomSnapshot.value?.room?.identifier,
      rootRoomSnapshot.value?.room?.displayName,
      rootRoomSnapshot.value?.room?.name,
      rootRoomSnapshot.value?.room?.code,
      app.activeEntry.value.type === "room" ? app.activeEntry.value.roomIdentifier : null,
      app.activeEntry.value.title,
    ]);
  }

  function forgetRecentRootRoomAliases(aliases: Set<string>): void {
    if (!aliases.size) return;
    const nextRecentRooms = recentRootRooms.value.filter(
      (room) =>
        !aliases.has(normalizeRoomIdentifier(room.identifier) || "") &&
        !aliases.has(normalizeRoomIdentifier(room.displayName) || ""),
    );
    if (nextRecentRooms.length === recentRootRooms.value.length) return;
    recentRootRooms.value = nextRecentRooms;
    rememberRecentRootRooms(recentRootRoomsStorageKey, nextRecentRooms);
  }

  async function openRoomFromAppAgent(roomIdentifier: string): Promise<void> {
    const normalizedIdentifier = normalizeRoomIdentifier(roomIdentifier);
    if (!normalizedIdentifier) return;
    const knownRoom = [...accountRooms.value, ...settingsAccountRooms.value]
      .find((room) => normalizeRoomIdentifier(room.roomIdentifier) === normalizedIdentifier);
    loading.value = true;
    try {
      const snapshot = await desktopIpc.room.getSnapshot(normalizedIdentifier);
      app.openRoomSnapshot(snapshot, {
        kind: "room",
        rootPath: null,
        meta: knownRoom?.role === "admin" ? "Admin" : "Account room",
      });
    } finally {
      loading.value = false;
    }
  }

  async function openServiceAgent(intent: AttentionNavigationIntent): Promise<void> {
    attentionIntent.value = null;
    notificationRevealMessageId.value = null;
    try {
      await openRoomFromAppAgent(intent.roomIdentifier);
      attentionIntent.value = intent;
    } catch (error) {
      app.pushActionToast(safeUserVisibleErrorDetail(error, "Could not open this agent’s room."), "error");
    }
  }
  return {
    leaveArchivedActiveRoomAfterAppAgent, leaveArchivedRoomIfActive,
    leaveArchivedSelectedRoomFromSettingsList, leaveArchivedActiveRoom, currentActiveRoomAliases,
    forgetRecentRootRoomAliases, openRoomFromAppAgent, openServiceAgent,
  };
}

/** Leave the active room once it is archived. */
export function useAppArchivedRoomWatcher(context: unknown) {
  const app = context as AppContextOf<"useAppArchivedRooms" | "useAppNavigation" | "useAppState">;
  const {
    activeEntry, currentActiveRoomAliases, leaveArchivedSelectedRoomFromSettingsList,
    rootRoomSnapshot, selectedRootRoomIdentifier, settingsAccountRooms,
  } = app;
  watch(
    [
      () => settingsAccountRooms.value,
      () => selectedRootRoomIdentifier.value,
      () => rootRoomSnapshot.value?.roomIdentifier || null,
      // The room list keeps its identity when a poll finds no change, so opening
      // an already-archived room must re-run the check by itself.
      () => activeEntry.value.type === "room" ? [...currentActiveRoomAliases()].sort().join("|") : "",
    ],
    () => {
      void leaveArchivedSelectedRoomFromSettingsList();
    },
    // No `deep`: the settings room list is replaced on every refresh, not edited in place.
    { immediate: true }
  );
}
