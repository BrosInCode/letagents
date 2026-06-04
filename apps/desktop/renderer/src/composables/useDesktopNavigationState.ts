import { computed, ref, type Ref } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopAppInfo,
  DesktopRoomAccess,
  DesktopRoomInfo,
  DesktopRoomSnapshot,
  RepoStatus,
} from "../../../electron/ipc-types";
import type { ProjectGroup, RoomEntry, SidebarEntry, SidebarMode } from "../components/desktop/types";
import { systemEntries } from "../domain/desktop-navigation";
import { readStoredString } from "../domain/desktop-storage";
import {
  buildSidebarProjectGroups,
  rememberRecentRootRooms,
  rootPathLabel,
  rootRoomEntryId,
  type RecentRootRoom,
  upsertRecentRootRoomSnapshot,
} from "../domain/sidebar-rooms";

interface DesktopNavigationStateOptions {
  accountRooms: Ref<DesktopAccountRoomEntry[]>;
  activeEntryStorageKey: string;
  appInfo: Ref<DesktopAppInfo | null>;
  recentRootRooms: Ref<RecentRootRoom[]>;
  recentRootRoomsStorageKey: string;
  repoStatus: Ref<RepoStatus | null>;
  rootRoomSnapshot: Ref<DesktopRoomSnapshot | null>;
  selectedRootRoomIdentifier: Ref<string | null>;
  selectedSnapshot: Ref<DesktopRoomSnapshot | null>;
}

interface OpenRoomOptions {
  rootPath?: string | null;
  meta?: string | null;
}

export function useDesktopNavigationState(options: DesktopNavigationStateOptions) {
  let activeEntryRestored = false;

  const repoName = computed(() => {
    return options.rootRoomSnapshot.value?.room?.displayName
      || options.rootRoomSnapshot.value?.roomIdentifier
      || options.repoStatus.value?.rootPath?.split("/").filter(Boolean).pop()
      || options.appInfo.value?.workspaceRoot?.split("/").filter(Boolean).pop()
      || "Room";
  });

  const focusRooms = computed(() => {
    return options.rootRoomSnapshot.value?.focusRooms || [];
  });

  const selectedRoomInfo = computed<DesktopRoomInfo>(() => {
    if (!options.selectedSnapshot.value?.room) {
      return {
        identifier: options.selectedSnapshot.value?.roomIdentifier || repoName.value,
        code: "",
        name: repoName.value,
        displayName: repoName.value,
        role: "participant",
        authenticated: false,
        kind: activeEntry.value.type === "room" && activeEntry.value.kind === "focus" ? "focus" : "main",
        parentRoomId: null,
        focusKey: null,
        sourceTaskId: null,
        focusStatus: null,
      };
    }
    return options.selectedSnapshot.value.room;
  });

  const selectedFocusRooms = computed(() => {
    return activeEntry.value.type === "room" && activeEntry.value.kind === "focus"
      ? []
      : options.selectedSnapshot.value?.focusRooms || [];
  });

  const selectedAccess = computed<DesktopRoomAccess>(() => {
    return options.selectedSnapshot.value?.access || {
      status: "unavailable",
      title: "Room unavailable",
      message: "LetAgents could not load this room yet.",
      roomIdentifier: options.selectedSnapshot.value?.roomIdentifier || null,
      deviceFlowUrl: null,
      code: null,
      httpStatus: null,
    };
  });

  const selectedNeedsAccess = computed(() => {
    return selectedAccess.value.status !== "ready";
  });

  const selectedRoomIdentifier = computed(() => {
    if (selectedNeedsAccess.value) return null;
    return selectedRoomInfo.value.identifier || options.selectedSnapshot.value?.roomIdentifier || null;
  });

  function rememberRootRoomSnapshot(
    snapshot: DesktopRoomSnapshot,
    rememberOptions: OpenRoomOptions = {}
  ): void {
    const rootPath = rememberOptions.rootPath || options.repoStatus.value?.rootPath || options.appInfo.value?.workspaceRoot || null;
    const nextRooms = upsertRecentRootRoomSnapshot({
      snapshot,
      recentRootRooms: options.recentRootRooms.value,
      rootPath,
      meta: rememberOptions.meta || options.repoStatus.value?.branch || snapshot.room?.code || rootPathLabel(rootPath) || "Room",
    });
    options.recentRootRooms.value = nextRooms;
    rememberRecentRootRooms(options.recentRootRoomsStorageKey, nextRooms);
  }

  const currentParentRoom = computed<RoomEntry>(() => ({
    id: rootRoomEntryId(options.rootRoomSnapshot.value?.roomIdentifier || options.selectedRootRoomIdentifier.value || repoName.value),
    type: "room",
    kind: "parent",
    roomIdentifier: options.rootRoomSnapshot.value?.roomIdentifier || options.selectedRootRoomIdentifier.value || null,
    title: repoName.value,
    meta: options.repoStatus.value?.branch || "Parent room",
    sectionLabel: "Parent room",
    headline: "Start here, then branch work into focused rooms when it needs space.",
    description:
      "The main room should feel like home base: familiar, recent, and connected to the focused work happening around it.",
  }));

  const projectEntries = computed<ProjectGroup[]>(() => buildSidebarProjectGroups({
    currentParentRoom: currentParentRoom.value,
    focusRooms: focusRooms.value,
    accountRooms: options.accountRooms.value,
    recentRootRooms: options.recentRootRooms.value,
  }));

  const pinnedRoom = computed<RoomEntry>(() => ({
    id: currentParentRoom.value.id,
    type: "room",
    kind: "parent",
    roomIdentifier: currentParentRoom.value.roomIdentifier,
    title: currentParentRoom.value.title,
    meta: currentParentRoom.value.meta,
    sectionLabel: currentParentRoom.value.sectionLabel,
    headline: currentParentRoom.value.headline,
    description: currentParentRoom.value.description,
  }));

  const activeEntry = ref<SidebarEntry>(pinnedRoom.value);
  const sidebarMode = ref<SidebarMode>("expanded");
  const roomsCollapsed = ref(false);
  const collapsedProjects = ref<Record<string, boolean>>({});

  function findSidebarEntryById(entryId: string): SidebarEntry | null {
    if (entryId === pinnedRoom.value.id) return pinnedRoom.value;
    if (entryId === currentParentRoom.value.id) return currentParentRoom.value;

    for (const group of projectEntries.value) {
      if (group.parent.id === entryId) return group.parent;
      const focusRoom = group.focusRooms.find((room) => room.id === entryId);
      if (focusRoom) return focusRoom;
    }

    return systemEntries.find((entry) => entry.id === entryId) || null;
  }

  function restoreActiveEntryFromStorage(): boolean {
    const storedEntryId = readStoredString(options.activeEntryStorageKey);
    if (!storedEntryId) return false;
    const storedEntry = findSidebarEntryById(storedEntryId);
    if (!storedEntry) return false;
    activeEntry.value = storedEntry;
    return true;
  }

  function selectSidebarEntry(entry: SidebarEntry): void {
    activeEntry.value = entry;
  }

  function cycleSidebar() {
    sidebarMode.value =
      sidebarMode.value === "expanded"
        ? "rail"
        : sidebarMode.value === "rail"
          ? "hidden"
          : "expanded";
  }

  function toggleProject(projectId: string) {
    collapsedProjects.value = {
      ...collapsedProjects.value,
      [projectId]: !collapsedProjects.value[projectId],
    };
  }

  function toggleRoomsCollapsed(): void {
    roomsCollapsed.value = !roomsCollapsed.value;
  }

  function openRoomSnapshot(
    snapshot: DesktopRoomSnapshot,
    openOptions: OpenRoomOptions = {}
  ): void {
    options.rootRoomSnapshot.value = snapshot;
    options.selectedSnapshot.value = snapshot;
    options.selectedRootRoomIdentifier.value = snapshot.roomIdentifier;
    rememberRootRoomSnapshot(snapshot, openOptions);
    activeEntry.value = currentParentRoom.value;
  }

  function resolveSelectedRoomIdentifier(baseRootSnapshot: DesktopRoomSnapshot | null): string | null {
    if (!baseRootSnapshot) return null;
    if (activeEntry.value.type !== "room") return baseRootSnapshot.roomIdentifier;
    if (activeEntry.value.kind !== "focus") return activeEntry.value.roomIdentifier || baseRootSnapshot.roomIdentifier;
    const focusRoom = baseRootSnapshot.focusRooms.find((room) => `room:focus:${room.roomId}` === activeEntry.value.id);
    return activeEntry.value.roomIdentifier || focusRoom?.identifier || null;
  }

  function reconcileActiveEntry(): void {
    if (!activeEntryRestored) {
      activeEntryRestored = true;
      if (restoreActiveEntryFromStorage()) return;
    }

    if (activeEntry.value.type !== "room") return;

    if (activeEntry.value.kind === "focus") {
      const nextFocus = projectEntries.value
        .flatMap((project) => project.focusRooms)
        .find((room) => room.id === activeEntry.value.id);
      activeEntry.value = nextFocus || currentParentRoom.value;
      return;
    }

    const nextParent = projectEntries.value.find((project) => project.parent.id === activeEntry.value.id)?.parent;
    activeEntry.value = nextParent || currentParentRoom.value;
  }

  function getAuthRoomIdentifier(): string | null {
    return selectedAccess.value.roomIdentifier
      || options.selectedSnapshot.value?.roomIdentifier
      || options.rootRoomSnapshot.value?.roomIdentifier
      || null;
  }

  return {
    activeEntry,
    collapsedProjects,
    currentParentRoom,
    cycleSidebar,
    focusRooms,
    getAuthRoomIdentifier,
    openRoomSnapshot,
    pinnedRoom,
    projectEntries,
    reconcileActiveEntry,
    rememberRootRoomSnapshot,
    repoName,
    resolveSelectedRoomIdentifier,
    roomsCollapsed,
    selectSidebarEntry,
    selectedAccess,
    selectedFocusRooms,
    selectedNeedsAccess,
    selectedRoomIdentifier,
    selectedRoomInfo,
    sidebarMode,
    toggleProject,
    toggleRoomsCollapsed,
  };
}
