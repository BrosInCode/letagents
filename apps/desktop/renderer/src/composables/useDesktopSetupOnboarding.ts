import { computed, type ComputedRef, type Ref } from "vue";
import type {
  DesktopAuthStatus,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRoomSnapshot,
  RepoStatus,
} from "../../../electron/ipc-types";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "../components/desktop/setup/types";
import type { RoomEntry, SidebarEntry } from "../components/desktop/types";
import { setupEntry } from "../domain/desktop-navigation";
import { defaultMcpTargetSelection, fallbackMcpInstallState } from "../domain/mcp-install";
import { rootPathLabel, type RecentRootRoomKind } from "../domain/sidebar-rooms";

interface OpenRoomOptions {
  displayName?: string | null;
  kind?: RecentRootRoomKind | null;
  rootPath?: string | null;
  meta?: string | null;
}

interface DesktopSetupOnboardingOptions {
  activeEntry: Ref<SidebarEntry>;
  authFeedback: Ref<string | null>;
  authStatus: Ref<DesktopAuthStatus | null>;
  firstRunStage: Ref<FirstRunWizardStage>;
  loading: Ref<boolean>;
  loadFirstRunRoomContext: () => Promise<void>;
  mcpInstallBusy: Ref<boolean>;
  mcpInstallFeedback: Ref<string | null>;
  mcpInstallState: Ref<DesktopMcpInstallState | null>;
  mcpWizardStep: Ref<DesktopMcpWizardStep>;
  openRoomSnapshot: (snapshot: DesktopRoomSnapshot, options?: OpenRoomOptions) => void;
  pinnedRoom: ComputedRef<RoomEntry>;
  refresh: () => Promise<void>;
  repoStatus: Ref<RepoStatus | null>;
  selectedMcpTargetIds: Ref<DesktopMcpInstallTargetId[]>;
  setupLoadError: Ref<string | null>;
}

export function useDesktopSetupOnboarding(options: DesktopSetupOnboardingOptions) {
  const showMcpInstaller = computed(() => {
    return Boolean(options.mcpInstallState.value) && options.activeEntry.value.id === setupEntry.id;
  });

  const showFirstRunGate = computed(() => {
    return !options.mcpInstallState.value?.completed;
  });

  const visibleMcpInstallState = computed<DesktopMcpInstallState>(() => {
    return options.mcpInstallState.value ?? fallbackMcpInstallState;
  });

  const setupApiAvailable = computed(() => {
    return Boolean(window.letagentsDesktop?.setup);
  });

  const firstRunFeedback = computed(() => {
    return options.mcpInstallFeedback.value
      || options.authFeedback.value
      || options.setupLoadError.value;
  });

  async function loadFirstRunSetup(): Promise<void> {
    options.loading.value = true;
    options.setupLoadError.value = null;
    try {
      if (!window.letagentsDesktop?.setup) {
        throw new Error("The desktop bridge is stale. Restart LetAgents Desktop so setup can install MCP automatically.");
      }
      const [nextMcpInstallState, nextAuthStatus] = await Promise.all([
        window.letagentsDesktop.setup.getMcpInstallState(),
        window.letagentsDesktop.auth.getStatus(),
      ]);
      options.mcpInstallState.value = nextMcpInstallState;
      options.authStatus.value = nextAuthStatus;
      await options.loadFirstRunRoomContext();
      if (!options.selectedMcpTargetIds.value.length) {
        options.selectedMcpTargetIds.value = defaultMcpTargetSelection(nextMcpInstallState);
      }
      options.firstRunStage.value = nextMcpInstallState.completed ? "github" : "mcp";

      if (nextMcpInstallState.completed && nextAuthStatus.authenticated) {
        await options.refresh();
      }
    } catch (error) {
      options.setupLoadError.value = error instanceof Error
        ? `Setup could not load yet: ${error.message}. Restart the desktop window if this keeps happening.`
        : "Setup could not load yet. Restart the desktop window if this keeps happening.";
      options.mcpInstallState.value = fallbackMcpInstallState;
      if (!options.selectedMcpTargetIds.value.length) {
        options.selectedMcpTargetIds.value = defaultMcpTargetSelection(fallbackMcpInstallState);
      }
      options.firstRunStage.value = "mcp";
    } finally {
      options.loading.value = false;
    }
  }

  function selectMcpTarget(targetId: DesktopMcpInstallTargetId): void {
    options.selectedMcpTargetIds.value = options.selectedMcpTargetIds.value.includes(targetId)
      ? options.selectedMcpTargetIds.value.filter((id) => id !== targetId)
      : [...options.selectedMcpTargetIds.value, targetId];
    options.mcpInstallFeedback.value = null;
  }

  function selectAllMcpTargets(): void {
    options.selectedMcpTargetIds.value = visibleMcpInstallState.value.targets.map((target) => target.id);
    options.mcpInstallFeedback.value = null;
  }

  function clearMcpTargetSelection(): void {
    options.selectedMcpTargetIds.value = [];
    options.mcpInstallFeedback.value = null;
  }

  function continueMcpOnboarding(): void {
    options.mcpInstallFeedback.value = null;
    options.mcpWizardStep.value = "install";
  }

  function goBackMcpOnboarding(): void {
    options.mcpInstallFeedback.value = null;
    options.mcpWizardStep.value = options.mcpWizardStep.value === "done" ? "install" : "choose";
  }

  function selectedInstallCwd(): string | null {
    return options.repoStatus.value?.rootPath?.trim() || null;
  }

  async function pickRepoRoom(): Promise<boolean> {
    options.loading.value = true;
    options.mcpInstallFeedback.value = null;
    options.authFeedback.value = "Opening the repo picker...";
    options.setupLoadError.value = null;
    try {
      if (!window.letagentsDesktop?.repos?.pickRoom) {
        throw new Error("Restart LetAgents Desktop so the repo picker can open.");
      }
      const result = await window.letagentsDesktop.repos.pickRoom();
      if (result.canceled) return false;
      if (result.error || !result.snapshot) {
        options.authFeedback.value = result.error || "LetAgents could not open a room from that folder.";
        return false;
      }
      options.repoStatus.value = result.repoStatus;
      const repoPathLabel = rootPathLabel(result.repoPath);
      const folderLabel = repoPathLabel || result.repoPath || "Selected project folder";
      options.openRoomSnapshot(result.snapshot, {
        displayName: folderLabel,
        kind: "project",
        rootPath: result.repoPath,
        meta: result.repoStatus?.branch || repoPathLabel || result.source || null,
      });
      const roomLabel = result.snapshot.room?.displayName || result.roomIdentifier;
      options.authFeedback.value = result.warning
        ? `${result.warning} Room selected: ${roomLabel}.`
        : `Repo room selected: ${roomLabel}. Open it when you are ready.`;
      return true;
    } catch (error) {
      options.authFeedback.value = error instanceof Error ? error.message : "LetAgents could not open the repo picker.";
      return false;
    } finally {
      options.loading.value = false;
    }
  }

  async function joinRoomCode(roomCode: string): Promise<void> {
    const roomIdentifier = roomCode.trim();
    if (!roomIdentifier) return;

    options.loading.value = true;
    options.mcpInstallFeedback.value = null;
    options.authFeedback.value = null;
    options.setupLoadError.value = null;
    try {
      if (!window.letagentsDesktop?.room?.getSnapshot) {
        throw new Error("Restart LetAgents Desktop so the room can be joined.");
      }
      const snapshot = await window.letagentsDesktop.room.getSnapshot(roomIdentifier);
      options.repoStatus.value = null;
      options.openRoomSnapshot(snapshot, {
        kind: "room",
        rootPath: null,
        meta: snapshot.room?.code || "Joined room",
      });
      options.authFeedback.value = snapshot.access.status === "ready"
        ? "Room selected. Open it when you are ready."
        : snapshot.access.message;
    } catch (error) {
      options.authFeedback.value = error instanceof Error ? error.message : "LetAgents could not join that room.";
    } finally {
      options.loading.value = false;
    }
  }

  function goBackFirstRun(): void {
    options.mcpInstallFeedback.value = null;
    options.authFeedback.value = null;
    options.setupLoadError.value = null;

    if (options.firstRunStage.value === "room") {
      options.firstRunStage.value = "github";
      return;
    }

    if (options.firstRunStage.value === "github") {
      options.firstRunStage.value = "mcp";
      options.mcpWizardStep.value = "done";
      return;
    }

    goBackMcpOnboarding();
  }

  async function installSelectedMcpTargets(): Promise<void> {
    const targetIds = [...options.selectedMcpTargetIds.value];
    if (!targetIds.length) {
      options.mcpInstallFeedback.value = "Choose at least one app.";
      return;
    }

    options.mcpInstallBusy.value = true;
    options.mcpInstallFeedback.value = null;
    options.setupLoadError.value = null;
    try {
      if (!window.letagentsDesktop?.setup) {
        throw new Error("Restart LetAgents Desktop so setup can install MCP automatically.");
      }
      const result = await window.letagentsDesktop.setup.installMcpServers(targetIds, {
        cwd: selectedInstallCwd(),
      });
      options.mcpInstallState.value = result.installState;
      options.selectedMcpTargetIds.value = result.targets.map((target) => target.id);
      options.mcpInstallFeedback.value = result.message;
      options.mcpWizardStep.value = "done";
    } catch (error) {
      options.mcpInstallFeedback.value = error instanceof Error
        ? error.message
        : "LetAgents could not update these apps' MCP settings.";
    } finally {
      options.mcpInstallBusy.value = false;
    }
  }

  function completeMcpOnboarding(): void {
    options.mcpInstallFeedback.value = null;
    options.setupLoadError.value = null;
    options.firstRunStage.value = "github";
  }

  function continueToRoomConfirmation(): void {
    options.authFeedback.value = null;
    void options.loadFirstRunRoomContext();
    options.firstRunStage.value = "room";
  }

  async function finishFirstRunOnboarding(): Promise<void> {
    if (!options.pinnedRoom.value.roomIdentifier) {
      options.authFeedback.value = "Choose a repo room or join with a room code first.";
      return;
    }

    options.mcpInstallBusy.value = true;
    options.mcpInstallFeedback.value = null;
    options.setupLoadError.value = null;
    try {
      if (!window.letagentsDesktop?.setup) {
        throw new Error("Restart LetAgents Desktop so setup can finish.");
      }
      const targetIds = [...options.selectedMcpTargetIds.value];
      const cwd = selectedInstallCwd();
      if (targetIds.length && cwd) {
        const result = await window.letagentsDesktop.setup.installMcpServers(targetIds, {
          cwd,
        });
        options.mcpInstallState.value = result.installState;
        options.selectedMcpTargetIds.value = result.targets.map((target) => target.id);
      }
      options.mcpInstallState.value = await window.letagentsDesktop.setup.completeMcpOnboarding();
      options.activeEntry.value = options.pinnedRoom.value;
      await options.refresh();
    } catch (error) {
      options.authFeedback.value = error instanceof Error ? error.message : "Could not close setup.";
    } finally {
      options.mcpInstallBusy.value = false;
    }
  }

  return {
    clearMcpTargetSelection,
    completeMcpOnboarding,
    continueMcpOnboarding,
    continueToRoomConfirmation,
    finishFirstRunOnboarding,
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
    showMcpInstaller,
    visibleMcpInstallState,
  };
}
