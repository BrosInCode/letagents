import { computed, nextTick, watch } from "vue";
import { activeRepoRoomContext, roomWithInheritedProjectContext } from "../../domain/room-project-context";
import { provideAgentRoomAudience } from "../useAgentRoomAudience";
import { useDesktopActionToasts } from "../useDesktopActionToasts";
import { useDesktopNavigationState } from "../useDesktopNavigationState";
import { rememberStoredString } from "../../domain/desktop-storage";
import { normalizeRoomIdentifier } from "../../domain/sidebar-rooms";
import { gitRoomsShareRepo } from "../../domain/app-room-aliases";
import type { AppContextOf } from "./context";

/** Sidebar navigation state: the active entry, projects, and the selected room. */
export function useAppNavigation(context: unknown) {
  const app = context as AppContextOf<"useAppState">;
  const {
    accountRooms, activeEntryStorageKey, appInfo, recentRootRooms, recentRootRoomsStorageKey,
    repoStatus, rootRoomSnapshot, selectedRootRoomIdentifier, selectedSnapshot,
  } = app;
  const {
    activeEntry,
    collapsedProjects,
    currentParentRoom,
    cycleSidebar: toggleSidebarMode,
    focusRooms,
    getAuthRoomIdentifier,
    openRoomSnapshot,
    pinnedCollapsed,
    pinnedRoom,
    projectEntries,
    reconcileActiveEntry,
    rememberRootRoomSnapshot,
    repoName,
    resolveSelectedRoomIdentifier,
    roomsCollapsed,
    returnFromSettings,
    selectSidebarEntry,
    selectedAccess,
    selectedFocusRooms,
    selectedNeedsAccess,
    selectedRoomIdentifier,
    selectedRoomInfo,
    sidebarMode,
    toggleProject,
    togglePinnedCollapsed,
    toggleRoomsCollapsed,
  } = useDesktopNavigationState({
    accountRooms,
    activeEntryStorageKey,
    appInfo,
    recentRootRooms,
    recentRootRoomsStorageKey,
    repoStatus,
    rootRoomSnapshot,
    selectedRootRoomIdentifier,
    selectedSnapshot,
  });
  Object.assign(app, { activeEntry, collapsedProjects, currentParentRoom, toggleSidebarMode, openRoomSnapshot, projectEntries, rememberRootRoomSnapshot, selectSidebarEntry, selectedRoomIdentifier, selectedRoomInfo, sidebarMode });
  return {
    activeEntry, collapsedProjects, currentParentRoom, toggleSidebarMode, focusRooms,
    getAuthRoomIdentifier, openRoomSnapshot, pinnedCollapsed, pinnedRoom, projectEntries,
    reconcileActiveEntry, rememberRootRoomSnapshot, repoName, resolveSelectedRoomIdentifier,
    roomsCollapsed, returnFromSettings, selectSidebarEntry, selectedAccess, selectedFocusRooms,
    selectedNeedsAccess, selectedRoomIdentifier, selectedRoomInfo, sidebarMode, toggleProject,
    togglePinnedCollapsed, toggleRoomsCollapsed,
  };
}

/** Action toasts and the selected room's project context. */
export function useAppRoomContext(context: unknown) {
  const app = context as AppContextOf<"useAppNavigation" | "useAppProjectRepo" | "useAppState">;
  const {
    activeEntry, activeProjectRootPath, authStatus, projectEntries, recentRootRooms, repoStatus,
    rootRoomSnapshot, selectedRoomInfo, selectedRootRoomIdentifier, selectedSnapshot,
  } = app;
  const { actionToasts, dismissActionToast, pushActionToast } = useDesktopActionToasts();
  Object.assign(app, { pushActionToast });

  const selectedRoomWithProjectContext = computed(() => {
    const room = selectedRoomInfo.value;
    const parentRoom = rootRoomSnapshot.value?.room || null;
    const isListedChild = Boolean(
      rootRoomSnapshot.value?.focusRooms.some((focusRoom) =>
        normalizeRoomIdentifier(focusRoom.identifier) === normalizeRoomIdentifier(room.identifier)
      )
    );
    return roomWithInheritedProjectContext(room, parentRoom, isListedChild);
  });
  Object.assign(app, { selectedRoomWithProjectContext });
  provideAgentRoomAudience(() => selectedRoomWithProjectContext.value, () => selectedSnapshot.value?.participants ?? [], () => [authStatus.value?.account?.login, authStatus.value?.account?.displayName]);

  const selectedGitRoomMatchesActiveRepo = computed(() => {
    const gitRoom = selectedRoomWithProjectContext.value.gitRoom;
    if (!gitRoom || !repoStatus.value?.isGitRepo) return false;
    const activeRoomIdentifier = normalizeRoomIdentifier(repoStatus.value.roomIdentifier);
    if (
      activeRoomIdentifier &&
      activeRoomIdentifier === normalizeRoomIdentifier(selectedRoomWithProjectContext.value.identifier)
    ) return true;
    const rootGitRoom = rootRoomSnapshot.value?.room?.gitRoom || null;
    if (rootGitRoom) return gitRoomsShareRepo(rootGitRoom, gitRoom);
    return normalizeRoomIdentifier(selectedRoomWithProjectContext.value.identifier)
      === normalizeRoomIdentifier(rootRoomSnapshot.value?.roomIdentifier);
  });

  const selectedRoomProjectRootPath = computed(() => activeProjectRootPath());
  const selectedRoomIsProject = computed(() => {
    if (selectedRoomWithProjectContext.value.gitRoom || selectedRoomProjectRootPath.value) return true;
    const context = activeRepoRoomContext(activeEntry.value?.id, projectEntries.value);
    const identifier = normalizeRoomIdentifier(
      context?.roomIdentifier
        ?? selectedRootRoomIdentifier.value
        ?? rootRoomSnapshot.value?.roomIdentifier,
    );
    if (!identifier) return false;
    return recentRootRooms.value.some((room) =>
      room.kind === "project" && normalizeRoomIdentifier(room.identifier) === identifier
    );
  });
  return {
    actionToasts, dismissActionToast, pushActionToast, selectedRoomWithProjectContext,
    selectedGitRoomMatchesActiveRepo, selectedRoomProjectRootPath, selectedRoomIsProject,
  };
}

/** React to entry changes, sidebar loads, and the selected root room. */
export function useAppSelectionWatchers(context: unknown) {
  const app = context as AppContextOf<
      "useAppInboxState"
    | "useAppNavigation"
    | "useAppRoomData"
    | "useAppRoomShellActions"
    | "useAppSidebarMessages"
    | "useAppState"
  >;
  const {
    activeChatScrollRoomIdentifier, activeEntry, activeEntryStorageKey,
    forgetLoadingChatScrollRooms, inboxRoomOpens, loading, markActiveRoomRead, projectEntries,
    refreshSelectedSnapshot, refreshSidebarLatestMessages, rootRoomSnapshot,
    selectedRootRoomIdentifier, selectedRootRoomStorageKey, sidebarMetadataRefresh,
  } = app;
  watch(
    () => activeEntry.value,
    async (nextEntry, previousEntry) => {
      const selectedEntryId = nextEntry.id;
      const previousRoomIdentifier = previousEntry?.type === "room" ? previousEntry.roomIdentifier : null;
      forgetLoadingChatScrollRooms([activeChatScrollRoomIdentifier()]);
      if (previousRoomIdentifier) {
        void nextTick(() => {
          forgetLoadingChatScrollRooms([previousRoomIdentifier]);
        });
      }
      rememberStoredString(activeEntryStorageKey, nextEntry.id);
      if (!rootRoomSnapshot.value) return;
      if (nextEntry.id === previousEntry?.id) return;
      await inboxRoomOpens.load(selectedEntryId, () => refreshSelectedSnapshot(rootRoomSnapshot.value));
      if (activeEntry.value.id !== selectedEntryId) return;
      markActiveRoomRead();
    }
  );

  watch(
    [() => projectEntries.value, () => loading.value],
    () => {
      if (loading.value || !rootRoomSnapshot.value) return;
      if (!sidebarMetadataRefresh.inFlight) {
        void refreshSidebarLatestMessages();
      }
    },
    { deep: true, immediate: true }
  );

  watch(
    () => selectedRootRoomIdentifier.value,
    (roomIdentifier) => {
      rememberStoredString(selectedRootRoomStorageKey, roomIdentifier);
    },
    { immediate: true }
  );
}
