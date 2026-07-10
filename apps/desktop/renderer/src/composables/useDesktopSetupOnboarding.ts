import { computed, ref, type ComputedRef, type Ref } from "vue";
import type {
  DesktopAuthStatus,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRoomAccess,
  DesktopRoomSnapshot,
  RepoStatus,
} from "../../../electron/ipc-types";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "../components/desktop/setup/types";
import type { RoomEntry, SidebarEntry } from "../components/desktop/types";
import { setupEntry } from "../domain/desktop-navigation";
import { defaultMcpTargetSelection, fallbackMcpInstallState } from "../domain/mcp-install";
import { rootPathLabel, type RecentRootRoomKind } from "../domain/sidebar-rooms";
import { desktopIpc } from "../ipc/index.js";

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
  const firstRunRoomSelected = ref(false);

  const showFirstRunGate = computed(() => {
    const installState = options.mcpInstallState.value;
    return installState !== null && !installState.completed;
  });

  const showFirstRunSplash = computed(() => {
    return options.mcpInstallState.value === null && !options.setupLoadError.value;
  });

  const visibleMcpInstallState = computed<DesktopMcpInstallState>(() => {
    return options.mcpInstallState.value ?? fallbackMcpInstallState;
  });

  const setupApiAvailable = computed(() => {
    return Boolean(desktopIpc.setup);
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
      if (!desktopIpc.setup) {
        throw new Error("The desktop app connection is stale. Restart LetAgents Desktop so setup can install agent app connections automatically.");
      }
      const [nextMcpInstallState, nextAuthStatus] = await Promise.all([
        desktopIpc.setup.getMcpInstallState(),
        desktopIpc.auth.getStatus(),
      ]);
      options.mcpInstallState.value = nextMcpInstallState;
      options.authStatus.value = nextAuthStatus;
      if (!options.selectedMcpTargetIds.value.length) {
        options.selectedMcpTargetIds.value = defaultMcpTargetSelection(nextMcpInstallState);
      }
      options.firstRunStage.value = nextMcpInstallState.completed ? "github" : "welcome";

      if (nextMcpInstallState.completed) {
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
      options.firstRunStage.value = "welcome";
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

  function startFirstRunSetup(): void {
    options.mcpInstallFeedback.value = null;
    options.authFeedback.value = null;
    options.setupLoadError.value = null;
    options.firstRunStage.value = "mcp";
    options.mcpWizardStep.value = "choose";
    firstRunRoomSelected.value = false;
  }

  function goBackMcpOnboarding(): void {
    options.mcpInstallFeedback.value = null;
    options.mcpWizardStep.value = options.mcpWizardStep.value === "done" ? "install" : "choose";
  }

  async function pickRepoRoom(): Promise<boolean> {
    options.loading.value = true;
    options.mcpInstallFeedback.value = null;
    options.authFeedback.value = "Opening the repo picker...";
    options.setupLoadError.value = null;
    firstRunRoomSelected.value = false;
    try {
      if (!desktopIpc.repos?.pickRoom) {
        throw new Error("Restart LetAgents Desktop so the repo picker can open.");
      }
      const result = await desktopIpc.repos.pickRoom();
      if (result.canceled) return false;
      if (result.error || !result.snapshot) {
        options.authFeedback.value = result.error || "LetAgents could not open a room from that folder.";
        return false;
      }
      const repoPathLabel = rootPathLabel(result.repoPath);
      const folderLabel = repoPathLabel || result.repoPath || "Selected project folder";
      const roomLabel = result.snapshot.room?.displayName || result.roomIdentifier || result.snapshot.roomIdentifier;
      if (!canSelectFirstRunRoom(result.snapshot.access.status)) {
        options.authFeedback.value = roomAccessFeedback(result.snapshot);
        return false;
      }
      options.repoStatus.value = result.repoStatus;
      options.openRoomSnapshot(result.snapshot, {
        displayName: folderLabel,
        kind: "project",
        rootPath: result.repoPath,
        meta: result.repoStatus?.branch || repoPathLabel || result.source || null,
      });
      options.authFeedback.value = firstRunRoomSelectedFeedback(result.snapshot, roomLabel, result.warning);
      firstRunRoomSelected.value = true;
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
    firstRunRoomSelected.value = false;
    try {
      if (!desktopIpc.room?.getSnapshot) {
        throw new Error("Restart LetAgents Desktop so the room can be joined.");
      }
      const snapshot = await desktopIpc.room.getSnapshot(roomIdentifier);
      if (!canSelectFirstRunRoom(snapshot.access.status)) {
        options.authFeedback.value = roomAccessFeedback(snapshot);
        return;
      }
      options.repoStatus.value = null;
      options.openRoomSnapshot(snapshot, {
        kind: "room",
        rootPath: null,
        meta: snapshot.room?.code || "Joined room",
      });
      options.authFeedback.value = firstRunRoomSelectedFeedback(snapshot);
      firstRunRoomSelected.value = true;
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

  async function installCodexRuntimeIfMissing(
    targetIds: DesktopMcpInstallTargetId[],
  ): Promise<string | null> {
    if (!targetIds.includes("codex")) return null;
    const workers = desktopIpc.workers;
    if (!workers?.runAgentProviderPreflight || !workers?.runAgentProviderSetup) return null;

    const preflight = await workers.runAgentProviderPreflight("codex", {});
    if (preflight.nextAction !== "install_runtime") {
      if (["auth_required", "bridge_required", "repo_required", "ready"].includes(preflight.status)) {
        return "Codex CLI is already installed.";
      }
      return null;
    }

    const result = await workers.runAgentProviderSetup("codex", {
      action: "install_runtime",
      confirmed: true,
    });
    if (!result.success) {
      throw new Error(result.message || "Codex CLI install failed.");
    }
    return result.message || null;
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
      if (!desktopIpc.setup) {
        throw new Error("Restart LetAgents Desktop so setup can install MCP automatically.");
      }
      const runtimeMessage = await installCodexRuntimeIfMissing(targetIds);
      const result = await desktopIpc.setup.installMcpServers(targetIds);
      options.mcpInstallState.value = result.installState;
      options.selectedMcpTargetIds.value = result.targets.map((target) => target.id);
      options.mcpInstallFeedback.value = [runtimeMessage, result.message].filter(Boolean).join(" ");
      if (!result.success || result.targets.some((target) => target.status !== "installed")) {
        options.mcpWizardStep.value = "install";
        return;
      }
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
    firstRunRoomSelected.value = false;
    options.firstRunStage.value = "room";
  }

  async function finishFirstRunOnboarding(): Promise<void> {
    const roomIdentifier = options.pinnedRoom.value.roomIdentifier;
    if (!firstRunRoomSelected.value || !roomIdentifier) {
      options.authFeedback.value = "Choose a repo room or join with a room code first.";
      return;
    }

    options.mcpInstallBusy.value = true;
    options.mcpInstallFeedback.value = null;
    options.setupLoadError.value = null;
    try {
      if (!desktopIpc.setup) {
        throw new Error("Restart LetAgents Desktop so setup can finish.");
      }
      if (!desktopIpc.room?.getSnapshot) {
        throw new Error("Restart LetAgents Desktop so the selected room can be verified.");
      }
      const snapshot = await desktopIpc.room.getSnapshot(roomIdentifier);
      if (snapshot.access.status !== "ready") {
        firstRunRoomSelected.value = snapshot.access.status === "auth_required";
        options.openRoomSnapshot(snapshot, firstRunRoomOpenOptions(snapshot, options));
        options.authFeedback.value = roomAccessFeedback(snapshot);
        return;
      }
      options.openRoomSnapshot(snapshot, firstRunRoomOpenOptions(snapshot, options));
      options.mcpInstallState.value = await desktopIpc.setup.completeMcpOnboarding();
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
    startFirstRunSetup,
    visibleMcpInstallState,
  };
}

function canSelectFirstRunRoom(status: DesktopRoomAccess["status"]): boolean {
  return status === "ready" || status === "auth_required";
}

function firstRunRoomSelectedFeedback(
  snapshot: DesktopRoomSnapshot,
  roomLabel = snapshot.room?.displayName || snapshot.roomIdentifier,
  warning?: string | null,
): string {
  if (snapshot.access.status === "auth_required") {
    return snapshot.access.message || `Room selected: ${roomLabel}. Connect GitHub before opening it.`;
  }
  const prefix = warning ? `${warning} ` : "";
  return `${prefix}Room selected: ${roomLabel}. Open it when you are ready.`;
}

function roomAccessFeedback(snapshot: DesktopRoomSnapshot): string {
  if (snapshot.access.status === "auth_required") {
    return snapshot.access.message || "Connect GitHub before opening this private room.";
  }
  return snapshot.access.message || snapshot.access.title || "LetAgents could not open that room.";
}

function firstRunRoomOpenOptions(
  snapshot: DesktopRoomSnapshot,
  options: DesktopSetupOnboardingOptions,
): OpenRoomOptions {
  const rootPath = options.repoStatus.value?.rootPath || null;
  return {
    displayName: snapshot.room?.displayName || options.pinnedRoom.value.title,
    kind: rootPath ? "project" : "room",
    rootPath,
    meta: options.repoStatus.value?.branch || snapshot.room?.code || options.pinnedRoom.value.meta || null,
  };
}
