import { computed, ref, watch } from "vue";
import { preserveRoomRepoStatistics } from "../../domain/repo-status";
import { isAuthSnapshotPending } from "../../components/desktop/content/auth-onboarding";
import { useDesktopAccountRoomSettings } from "../useDesktopAccountRoomSettings";
import { useDesktopAppData } from "../useDesktopAppData";
import { useDesktopNewRoomModal } from "../useDesktopNewRoomModal";
import { useDesktopRoomLiveSync } from "../useDesktopRoomLiveSync";
import { settingsEntry } from "../../domain/desktop-navigation";
import { normalizeRoomIdentifier } from "../../domain/sidebar-rooms";
import { promoteSidebarProject, rememberSidebarRoomOrder } from "../../domain/sidebar-room-order";
import type { AppContextOf } from "./context";

/** Live room metadata and the app's room and account data. */
export function useAppRoomData(context: unknown) {
  const app = context as AppContextOf<"useAppNavigation" | "useAppState">;
  const {
    accountRooms, activeEntry, appInfo, authStatus, currentParentRoom, diagnostics, loading,
    mcpInstallState, recentRootRooms, reconcileActiveEntry, rememberRootRoomSnapshot, repoStatus,
    resolveSelectedRoomIdentifier, rootRoomSnapshot, selectedMcpTargetIds, selectedRoomIdentifier,
    selectedRootRoomIdentifier, selectedSnapshot, sessionGeneration, settingsAccountRooms, workers,
  } = app;
  // The room shell reports each Activity tab that comes on screen or leaves it.
  // A count, not a flag: when the room changes, the new room's tab can report
  // itself before the old room's tab reports that it left.
  const activityTabsOnScreen = ref(0);
  const roomActivityHistoryVisible = computed(() => activityTabsOnScreen.value > 0);
  function setRoomActivityHistoryVisible(visible: boolean): void {
    activityTabsOnScreen.value = Math.max(0, activityTabsOnScreen.value + (visible ? 1 : -1));
  }
  // The explicit room refresh reads through the stream's read barrier. The
  // data layer below owns that barrier and is created after the live sync.
  let readRoomThroughStream: ((roomIdentifier: string) => Promise<boolean>) | null = null;
  const {
    clearLiveMetadataRefreshInterval,
    clearLiveMetadataRefreshTimer,
    clearSelectedRoomAgentWork,
    invalidateSelectedRoomAgentWork,
    refreshSelectedRoomLiveMetadata,
    roomAgentWork,
    roomAgentWorkStatus,
    roomAgentWorkTruncated,
    scheduleLiveMetadataRefresh,
    syncSelectedRoomStream: syncDesktopRoomStream,
  } = useDesktopRoomLiveSync({
    accountId: computed(() => authStatus.value?.account?.id || null),
    activityHistoryVisible: roomActivityHistoryVisible,
    readRoomThroughStream: (roomIdentifier) => readRoomThroughStream?.(roomIdentifier) ?? Promise.resolve(false),
    rootRoomSnapshot,
    selectedRoomIdentifier,
    selectedSnapshot,
    sessionGeneration,
    workers,
  });
  Object.assign(app, { clearLiveMetadataRefreshInterval, clearLiveMetadataRefreshTimer, clearSelectedRoomAgentWork, invalidateSelectedRoomAgentWork, refreshSelectedRoomLiveMetadata });

  const {
    clearSelectedSnapshotCache,
    handleMessageSent,
    handleRefreshRoom,
    handleContentDeleted,
    handleRoomRenamed,
    handleRoomStreamEvent,
    invalidateSession,
    readSelectedRoomThroughStream,
    refresh,
    refreshAccountRooms,
    refreshActiveRoom,
    refreshSelectedSnapshot,
    repoStatusValue,
    selectedSnapshotLoading,
    syncSelectedRoomStream,
    upsertSelectedTask,
  } = useDesktopAppData({
    accountRooms,
    activeEntry,
    appInfo,
    authStatus,
    currentParentRoom,
    diagnostics,
    loading,
    mcpInstallState,
    reconcileActiveEntry,
    rememberRootRoomSnapshot,
    recentRootRooms,
    repoStatus,
    resolveSelectedRoomIdentifier,
    rootRoomSnapshot,
    scheduleLiveMetadataRefresh,
    sessionGeneration,
    selectedMcpTargetIds,
    selectedRootRoomIdentifier,
    selectedSnapshot,
    settingsAccountRooms,
    syncRoomStream: syncDesktopRoomStream,
    workers,
  });
  readRoomThroughStream = readSelectedRoomThroughStream;
  Object.assign(app, { clearSelectedSnapshotCache, handleMessageSent, handleRefreshRoom, handleContentDeleted, handleRoomStreamEvent, invalidateSession, refresh, refreshAccountRooms, refreshActiveRoom, refreshSelectedSnapshot, selectedSnapshotLoading, syncSelectedRoomStream });

  const authSnapshotPending = computed(() =>
    isAuthSnapshotPending({
      rootLoading: loading.value,
      selectedLoading: selectedSnapshotLoading.value,
      hasSnapshot: Boolean(selectedSnapshot.value),
    }),
  );
  return {
    clearLiveMetadataRefreshInterval, clearLiveMetadataRefreshTimer, clearSelectedRoomAgentWork,
    invalidateSelectedRoomAgentWork, refreshSelectedRoomLiveMetadata, roomAgentWork,
    roomAgentWorkStatus, roomAgentWorkTruncated, scheduleLiveMetadataRefresh,
    syncDesktopRoomStream, clearSelectedSnapshotCache, handleMessageSent, handleRefreshRoom, handleContentDeleted,
    handleRoomRenamed, handleRoomStreamEvent, invalidateSession, refresh, refreshAccountRooms,
    refreshActiveRoom, refreshSelectedSnapshot, repoStatusValue, selectedSnapshotLoading, syncSelectedRoomStream,
    upsertSelectedTask, authSnapshotPending, setRoomActivityHistoryVisible,
  };
}

/** The new room modal and account room settings. */
export function useAppRoomManagement(context: unknown) {
  const app = context as AppContextOf<
      "useAppArchivedRooms"
    | "useAppCompany"
    | "useAppNavigation"
    | "useAppRoomContext"
    | "useAppRoomData"
    | "useAppSidebarEntries"
    | "useAppState"
  >;
  const {
    accountRooms, activeEntry, chatStorageSettings, handleRoomRenamed, leaveArchivedRoomIfActive,
    loading, openRoomSnapshot, pushActionToast, recentRootRooms, recentRootRoomsStorageKey,
    refresh, refreshAccountRooms, repoStatus, rootRoomSnapshot, selectedRoomIdentifier,
    selectedRootRoomIdentifier, selectedSnapshot, settingsAccountRooms, sidebarMode,
    sidebarProjectEntries, sidebarRevealRequest, sidebarRoomOrder, sidebarRoomOrderStorageKey,
  } = app;
  const newRoomCompanies = computed(() => app.company.organizations.value
    .filter(company => company.joined)
    .map(company => ({ id: company.github_org_id, login: company.login, avatarUrl: company.avatar_url })));
  const {
    backFromSubstep,
    canSubmitJoin,
    canSubmitStandalone,
    chooseJoinIntent,
    chooseProjectIntent,
    chooseNewProjectIntent,
    closeNewRoomModal,
    confirmProjectRoomFromModal,
    createStandaloneRoom,
    createProjectRoomFromModal,
    joinRoomCodeFromModal,
    newRoomActiveAction,
    newRoomBusy,
    newRoomCanDismiss,
    newRoomFeedback,
    newRoomFeedbackState,
    newRoomJoinCode,
    newRoomJoinError,
    newRoomModalOpen,
    newRoomName,
    newRoomProjectPath,
    newRoomProjectName,
    newRoomProjectParent,
    newRoomProjectCreationError,
    newRoomProjectPathError,
    newRoomProjectSelection,
    newRoomStatusMessage,
    newRoomStep,
    newRoomStorage,
    newRoomCompany,
    openProjectRoomFromModal,
    openProjectRoomFromPath,
    pickNewProjectParent,
    removeProject,
    retryLastAction,
    selectNewRoomEntry,
  } = useDesktopNewRoomModal({
    openRoomSnapshot: (snapshot, options) => {
      openRoomSnapshot(snapshot, options);
      if (options?.kind !== "project") return;
      const entryId = activeEntry.value.id;
      const project = sidebarProjectEntries.value.find((candidate) =>
        [candidate.parent, ...candidate.branchRooms, ...candidate.focusRooms]
          .some((entry) => entry.id === entryId));
      if (project) {
        const order = promoteSidebarProject(sidebarProjectEntries.value, sidebarRoomOrder.value, project.id);
        if (order) {
          sidebarRoomOrder.value = order;
          rememberSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey, order);
        }
      }
      sidebarMode.value = "expanded";
      sidebarRevealRequest.value = {
        entryId,
        sequence: (sidebarRevealRequest.value?.sequence || 0) + 1,
      };
    },
    setRepoStatus: (status) => {
      if (status) repoStatus.value = preserveRoomRepoStatistics(repoStatus.value, status);
    },
    getDefaultStorageMode: () =>
      chatStorageSettings.value?.defaultMode === "local" || chatStorageSettings.value?.mode === "local"
        ? "local"
        : "cloud",
    getCompany: () => {
      const selected = app.company.selected.value;
      return selected?.joined ? { id: selected.github_org_id, login: selected.login, avatarUrl: selected.avatar_url } : null;
    },
    onCreationWarning: (message) => pushActionToast(message, "info", 15000),
    onCompanyRoomCreated: (room) => {
      if (app.company.activeId.value !== room.organizationId) void app.company.choose(room.organizationId);
      app.company.rememberCreatedRoom(room);
    },
    onCompanyLink: (organizationId) => app.receiveCompanyInvite(organizationId),
  });
  const {
    batchConcludeSidebarFocusRooms,
    batchHideSidebarRooms,
    batchSetSidebarRoomsPinned,
    archiveSidebarFocusRoom,
    archiveSidebarRoom,
    concludeSidebarFocusRoom,
    deleteAccountRoom, pendingRoomDeletion, confirmRoomDeletion, finishRoomArchive,
    leaveAccountRoom,
    openAccountRoomFromSettings,
    refreshSettings,
    renameSidebarRoom,
    restoreAccountRoom,
    settingsFeedback,
    settingsRoomActionBusyKey,
    toggleAccountRoomPin,
    togglePinSidebarRoom,
  } = useDesktopAccountRoomSettings({
    accountRooms,
    activeEntry,
    loading,
    recentRootRooms,
    recentRootRoomsStorageKey,
    rootRoomSnapshot,
    selectedRootRoomIdentifier,
    selectedSnapshot,
    settingsAccountRooms,
    settingsEntry,
    openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
    refresh: () => refresh(),
    refreshAccountRooms: () => refreshAccountRooms(),
    onRoomArchived: async (roomIdentifier, displayName) => {
      await leaveArchivedRoomIfActive(roomIdentifier, displayName);
    },
    onActiveRoomDeleted: async () => {
      const nextRoom = accountRooms.value.find(room => !room.archived);
      if (nextRoom) await app.openRoomFromAppAgent(nextRoom.roomIdentifier, { create: false });
      else selectNewRoomEntry();
    },
    onRoomRenamed: (room) => {
      if (normalizeRoomIdentifier(room.identifier) === normalizeRoomIdentifier(selectedRoomIdentifier.value)) {
        handleRoomRenamed(room);
      }
    },
    notify: (message, state) => pushActionToast(message, state),
  });
  Object.assign(app, { batchConcludeSidebarFocusRooms, batchHideSidebarRooms, batchSetSidebarRoomsPinned, concludeSidebarFocusRoom, refreshSettings, settingsRoomActionBusyKey });
  return {
    backFromSubstep, canSubmitJoin, canSubmitStandalone, chooseJoinIntent, chooseProjectIntent,
    chooseNewProjectIntent, closeNewRoomModal, confirmProjectRoomFromModal,
    createStandaloneRoom, createProjectRoomFromModal,
    joinRoomCodeFromModal, newRoomActiveAction, newRoomBusy, newRoomCanDismiss, newRoomFeedback,
    newRoomFeedbackState, newRoomJoinCode, newRoomJoinError, newRoomModalOpen, newRoomName,
    newRoomProjectPath, newRoomProjectName, newRoomProjectParent, newRoomProjectCreationError,
    newRoomProjectPathError, newRoomProjectSelection, newRoomStatusMessage, newRoomStep,
    newRoomStorage, newRoomCompany, newRoomCompanies, removeProject, openProjectRoomFromModal, openProjectRoomFromPath,
    pickNewProjectParent, retryLastAction, selectNewRoomEntry,
    batchConcludeSidebarFocusRooms, batchHideSidebarRooms, batchSetSidebarRoomsPinned,
    archiveSidebarFocusRoom, archiveSidebarRoom, concludeSidebarFocusRoom, deleteAccountRoom, pendingRoomDeletion, confirmRoomDeletion, finishRoomArchive,
    leaveAccountRoom, openAccountRoomFromSettings, refreshSettings, renameSidebarRoom,
    restoreAccountRoom, settingsFeedback, settingsRoomActionBusyKey, toggleAccountRoomPin,
    togglePinSidebarRoom,
  };
}

/** Keep the selected room's stream in sync. */
export function useAppRoomStreamWatchers(context: unknown) {
  const app = context as AppContextOf<
      "useAppNavigation"
    | "useAppRoomData"
    | "useAppSidebarMessages"
    | "useAppState"
  >;
  const {
    markActiveRoomRead, selectedRoomIdentifier, selectedSnapshot, syncSelectedRoomStream,
  } = app;
  watch(
    () => selectedRoomIdentifier.value,
    (roomIdentifier) => {
      void syncSelectedRoomStream(roomIdentifier);
    }
  );

  watch(
    () => selectedSnapshot.value?.messages.at(-1)?.id || null,
    () => {
      if (!selectedRoomIdentifier.value) return;
      void syncSelectedRoomStream(selectedRoomIdentifier.value);
      markActiveRoomRead();
    }
  );
}
