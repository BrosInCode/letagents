import type { DesktopAppAgentRunInput, DesktopAppAgentSaveSettingsInput, DesktopChatStorageSettings } from "../../../../electron/ipc-types";
import { useDesktopSetupOnboarding } from "../useDesktopSetupOnboarding";
import { appAgentEntry } from "../../domain/desktop-navigation";
import { appAgentRefreshTargets } from "../../domain/app-agent";
import { desktopIpc } from "../../ipc/index.js";
import type { AppContextOf } from "./context";

/** Settings surface: chat storage, the App Agent, and desktop updates. */
export function useAppSettingsActions(context: unknown) {
  const app = context as AppContextOf<
      "useAppArchivedRooms"
    | "useAppNavigation"
    | "useAppProjectRepo"
    | "useAppRoomData"
    | "useAppRoomManagement"
    | "useAppSessionActions"
    | "useAppState"
    | "appVuePending"
  >;
  const {
    appAgentActions, appAgentBusy, appAgentFeedback, appAgentResult, appAgentSettingsStatus,
    chatStorageAvailable, chatStorageBusy, chatStorageFeedback, chatStorageSettings,
    rootRoomSnapshot, selectedRootRoomIdentifier, selectedSnapshot, sessionGeneration,
    updateStatus,
  } = app;
  function getChatStorageBridge(): typeof desktopIpc.chatStorage | null {
    const bridge = desktopIpc.chatStorage;
    if (!bridge) {
      chatStorageAvailable.value = false;
      chatStorageFeedback.value = {
        state: "error",
        message: "Restart LetAgents Desktop to enable chat storage controls.",
      };
      return null;
    }
    chatStorageAvailable.value = true;
    return bridge;
  }

  async function loadChatStorageSettings(): Promise<void> {
    const bridge = getChatStorageBridge();
    if (!bridge) return;
    const generation = sessionGeneration.value;
    try {
      const settings = await bridge.getSettings();
      if (generation === sessionGeneration.value) chatStorageSettings.value = settings;
    } catch (error) {
      chatStorageFeedback.value = {
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : "Chat storage settings could not be loaded.",
      };
    }
  }

  async function loadAppAgentSettingsStatus(): Promise<void> {
    try {
      appAgentSettingsStatus.value = await desktopIpc.appAgent.getSettingsStatus();
    } catch (error) {
      appAgentFeedback.value = {
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : "App Agent settings could not be loaded.",
      };
    }
  }

  async function loadAppAgentActions(): Promise<void> {
    try {
      appAgentActions.value = await desktopIpc.appAgent.listActions();
    } catch (error) {
      appAgentFeedback.value = {
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : "App Agent actions could not be loaded.",
      };
    }
  }

  async function saveAppAgentSettings(input: DesktopAppAgentSaveSettingsInput): Promise<void> {
    appAgentBusy.value = true;
    appAgentFeedback.value = null;
    try {
      appAgentSettingsStatus.value = await desktopIpc.appAgent.saveSettings(input);
      appAgentFeedback.value = {
        state: "success",
        message: "App Agent settings saved.",
      };
    } catch (error) {
      appAgentFeedback.value = {
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : "App Agent settings could not be saved.",
      };
    } finally {
      appAgentBusy.value = false;
    }
  }

  async function refreshSettingsSurface(): Promise<void> {
    await Promise.all([
      app.refreshSettings(),
      loadAppAgentSettingsStatus(),
      loadAppAgentActions(),
      refreshDesktopUpdateStatus(),
    ]);
  }

  async function refreshDesktopUpdateStatus(): Promise<void> {
    if (!desktopIpc.updates?.getStatus) return;
    updateStatus.value = await desktopIpc.updates.getStatus();
  }

  async function checkDesktopUpdate(): Promise<void> {
    if (!desktopIpc.updates?.check) return;
    updateStatus.value = await desktopIpc.updates.check();
  }

  async function installDesktopUpdate(): Promise<void> {
    if (!desktopIpc.updates?.install) return;
    updateStatus.value = await desktopIpc.updates.install();
  }

  function openAppAgentSettings(): void {
    app.activeEntry.value = appAgentEntry;
  }

  async function runAppAgent(input: DesktopAppAgentRunInput): Promise<void> {
    appAgentBusy.value = true;
    appAgentResult.value = null;
    try {
      const runInput: DesktopAppAgentRunInput = {
        ...input,
        activeRoomDisplayName:
          input.activeRoomDisplayName || app.selectedRoomInfo.value.displayName || app.activeEntry.value.title,
        activeRoomIdentifier:
          input.activeRoomIdentifier || app.selectedRoomIdentifier.value || selectedRootRoomIdentifier.value,
        activeRoomPinned:
          input.activeRoomPinned === true || (app.activeEntry.value.type === "room" && app.activeEntry.value.pinned),
        activeRoomGitRoom:
          input.activeRoomGitRoom || app.selectedRoomInfo.value.gitRoom || null,
      };
      const result = await desktopIpc.appAgent.run(runInput);
      appAgentResult.value = result;
      if (result.settingsStatus) {
        appAgentSettingsStatus.value = result.settingsStatus;
      }
      const refreshTargets = appAgentRefreshTargets(result);
      if (refreshTargets.includes("rooms")) {
        await app.refreshAccountRooms();
      }
      const archivedActiveRoom =
        await app.leaveArchivedActiveRoomAfterAppAgent(result, runInput, {
          deferNavigation: Boolean(result.openRoomIdentifier),
        }) ||
        await app.leaveArchivedSelectedRoomFromSettingsList();
      if (result.openRoomIdentifier) {
        await app.openRoomFromAppAgent(result.openRoomIdentifier);
      }
      if (refreshTargets.includes("settings")) {
        await Promise.all([
          refreshSettingsSurface(),
          loadChatStorageSettings(),
        ]);
      }
      if (refreshTargets.includes("active_room") && !archivedActiveRoom) {
        await app.refreshSelectedSnapshot(rootRoomSnapshot.value);
      }
      if (refreshTargets.includes("foreground")) {
        app.refreshForegroundData();
      }
    } catch (error) {
      appAgentResult.value = {
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : "The App Agent could not complete that request.",
      };
    } finally {
      appAgentBusy.value = false;
    }
  }

  async function refreshActiveRoomAfterChatStorageChange(): Promise<void> {
    await desktopIpc.room.stopStream();
    await app.refreshActiveRepoStatus();
    app.clearSelectedSnapshotCache();
    selectedSnapshot.value = null;
    const rootRoomIdentifier = selectedRootRoomIdentifier.value || rootRoomSnapshot.value?.roomIdentifier || null;
    if (rootRoomIdentifier) {
      const nextRootSnapshot = await desktopIpc.room.getSnapshot(rootRoomIdentifier);
      rootRoomSnapshot.value = nextRootSnapshot;
      selectedRootRoomIdentifier.value = nextRootSnapshot.roomIdentifier;
      app.rememberRootRoomSnapshot(nextRootSnapshot);
      await app.refreshSelectedSnapshot(nextRootSnapshot);
    }
    if (app.selectedRoomIdentifier.value) {
      await app.syncSelectedRoomStream(app.selectedRoomIdentifier.value);
    }
  }

  async function setChatStorageMode(mode: DesktopChatStorageSettings["mode"]): Promise<void> {
    chatStorageBusy.value = true;
    chatStorageFeedback.value = null;
    try {
      const bridge = getChatStorageBridge();
      if (!bridge) return;
      chatStorageSettings.value = await bridge.setMode(mode);
      chatStorageFeedback.value = {
        state: "success",
        message:
          mode === "local"
            ? "Local chat storage is on. New messages stay on this computer."
            : "Cloud chat storage is on. Local history remains local until you publish it.",
      };
      await refreshActiveRoomAfterChatStorageChange();
    } catch (error) {
      chatStorageFeedback.value = {
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : "Chat storage mode could not be updated.",
      };
    } finally {
      chatStorageBusy.value = false;
    }
  }

  async function syncLocalChat(): Promise<void> {
    const roomIdentifier = app.selectedRoomIdentifier.value || selectedRootRoomIdentifier.value;
    const generation = sessionGeneration.value;
    if (!roomIdentifier) {
      chatStorageFeedback.value = {
        state: "error",
        message: "Open a room before publishing local chat.",
      };
      return;
    }
    chatStorageBusy.value = true;
    chatStorageFeedback.value = null;
    try {
      const bridge = getChatStorageBridge();
      if (!bridge) return;
      const result = await bridge.syncLocalRoom(roomIdentifier);
      if (generation !== sessionGeneration.value
        || (app.selectedRoomIdentifier.value || selectedRootRoomIdentifier.value) !== roomIdentifier) return;
      chatStorageFeedback.value = {
        state: result.skippedCount > 0 || result.skippedTaskCount > 0 ? "info" : "success",
        message:
          result.skippedCount > 0 || result.skippedTaskCount > 0
            ? `Published ${result.syncedCount} messages and ${result.syncedTaskCount} tasks. ${result.skippedCount + result.skippedTaskCount} items were skipped.`
            : `Published ${result.syncedCount} messages and ${result.syncedTaskCount} tasks.`,
      };
      if ((app.selectedRoomIdentifier.value || selectedRootRoomIdentifier.value) === roomIdentifier) {
        const snapshot = await desktopIpc.room.getSnapshot(roomIdentifier);
        if (generation !== sessionGeneration.value
          || (app.selectedRoomIdentifier.value || selectedRootRoomIdentifier.value) !== roomIdentifier) return;
        await app.handleRoomShellRefresh(snapshot);
      }
    } catch (error) {
      if (generation !== sessionGeneration.value
        || (app.selectedRoomIdentifier.value || selectedRootRoomIdentifier.value) !== roomIdentifier) return;
      chatStorageFeedback.value = {
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : "Local chat could not be published.",
      };
    } finally {
      chatStorageBusy.value = false;
    }
  }
  return {
    getChatStorageBridge, loadChatStorageSettings, loadAppAgentSettingsStatus, loadAppAgentActions,
    saveAppAgentSettings, refreshSettingsSurface, refreshDesktopUpdateStatus, checkDesktopUpdate,
    installDesktopUpdate, openAppAgentSettings, runAppAgent,
    refreshActiveRoomAfterChatStorageChange, setChatStorageMode, syncLocalChat,
  };
}

/** First-run setup and MCP onboarding. */
export function useAppSetupOnboarding(context: unknown) {
  const app = context as AppContextOf<
      "useAppAuthFlow"
    | "useAppNavigation"
    | "useAppRoomData"
    | "useAppState"
  >;
  const {
    activeEntry, authFeedback, authStatus, firstRunStage, loading, mcpInstallBusy,
    mcpInstallFeedback, mcpInstallState, mcpWizardStep, openRoomSnapshot, pinnedRoom, refresh,
    repoStatus, selectedMcpTargetIds, setupLoadError,
  } = app;
  const {
    clearMcpTargetSelection,
    completeMcpOnboarding,
    continueMcpOnboarding,
    continueToRoomConfirmation,
    createFirstRunInviteRoom,
    finishFirstRunOnboarding,
    firstRunInviteCode,
    firstRunRoomSelected,
    firstRunFeedback,
    goBackFirstRun,
    goBackMcpOnboarding,
    installSelectedMcpTargets,
    joinRoomCode,
    loadFirstRunSetup,
    pickRepoRoom,
    selectAllMcpTargets,
    selectMcpTarget,
    setupApiAvailable,
    showFirstRunGate,
    showFirstRunSplash,
    visibleMcpInstallState,
    startFirstRunSetup,
  } = useDesktopSetupOnboarding({
    activeEntry,
    authFeedback,
    authStatus,
    firstRunStage,
    loading,
    mcpInstallBusy,
    mcpInstallFeedback,
    mcpInstallState,
    mcpWizardStep,
    openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
    pinnedRoom,
    refresh: () => refresh(),
    repoStatus,
    selectedMcpTargetIds,
    setupLoadError,
  });
  Object.assign(app, { showFirstRunGate });
  return {
    clearMcpTargetSelection, completeMcpOnboarding, continueMcpOnboarding,
    continueToRoomConfirmation, createFirstRunInviteRoom, finishFirstRunOnboarding,
    firstRunInviteCode, firstRunRoomSelected, firstRunFeedback, goBackFirstRun,
    goBackMcpOnboarding, installSelectedMcpTargets, joinRoomCode, loadFirstRunSetup, pickRepoRoom,
    selectAllMcpTargets, selectMcpTarget, setupApiAvailable, showFirstRunGate, showFirstRunSplash,
    visibleMcpInstallState, startFirstRunSetup,
  };
}
