import { computed, nextTick, ref, type ComputedRef, type Ref } from "vue";
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

const defaultInitialBootstrapTimeoutMs = 10_000;
const defaultMcpInstallRevealDelayMs = 160;

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
  requestFirstAgent?: (providerId: DesktopMcpInstallTargetId) => void;
  refresh: () => Promise<void>;
  repoStatus: Ref<RepoStatus | null>;
  selectedMcpTargetIds: Ref<DesktopMcpInstallTargetId[]>;
  setupLoadError: Ref<string | null>;
  initialBootstrapTimeoutMs?: number;
  mcpInstallRevealDelayMs?: number;
}

export function useDesktopSetupOnboarding(options: DesktopSetupOnboardingOptions) {
  const firstRunRoomSelected = ref(false);
  const firstRunInviteCode = ref<string | null>(null);
  const firstRunAgentTargetId = ref<DesktopMcpInstallTargetId | null>(null);
  const initialBootstrapPending = ref(true);

  const showFirstRunGate = computed(() => {
    const installState = options.mcpInstallState.value;
    return installState !== null && !installState.completed;
  });

  const showFirstRunSplash = computed(() => {
    return initialBootstrapPending.value && !options.setupLoadError.value;
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

      // A signed-out desktop is an auth surface, not a public-room preview.
      // Do not load any room/account payload until GitHub authorization has
      // completed; useDesktopAuthFlow performs the first refresh after that.
      if (nextMcpInstallState.completed && nextAuthStatus.authenticated) {
        await waitForInitialRefresh(
          options.refresh,
          options.initialBootstrapTimeoutMs ?? defaultInitialBootstrapTimeoutMs,
        );
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
      initialBootstrapPending.value = false;
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
    firstRunInviteCode.value = null;
    firstRunAgentTargetId.value = null;
  }

  function goBackMcpOnboarding(): void {
    options.mcpInstallFeedback.value = null;
    options.mcpWizardStep.value = "choose";
  }

  async function pickRepoRoom(): Promise<boolean> {
    options.loading.value = true;
    options.mcpInstallFeedback.value = null;
    options.authFeedback.value = "Opening the repo picker...";
    options.setupLoadError.value = null;
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
      firstRunInviteCode.value = null;
      options.authFeedback.value = result.warning
        || (result.snapshot.access.status === "auth_required" ? roomAccessFeedback(result.snapshot) : null);
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
    firstRunInviteCode.value = null;
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
      options.authFeedback.value = snapshot.access.status === "auth_required"
        ? roomAccessFeedback(snapshot)
        : null;
      firstRunRoomSelected.value = true;
    } catch (error) {
      options.authFeedback.value = error instanceof Error ? error.message : "LetAgents could not join that room.";
    } finally {
      options.loading.value = false;
    }
  }

  async function createFirstRunInviteRoom(): Promise<void> {
    if (options.loading.value) return;

    options.loading.value = true;
    options.mcpInstallFeedback.value = null;
    options.authFeedback.value = null;
    options.setupLoadError.value = null;
    firstRunRoomSelected.value = false;
    firstRunInviteCode.value = null;
    try {
      if (!desktopIpc.room?.createInviteRoom) {
        throw new Error("Restart LetAgents Desktop so a room can be created.");
      }
      const result = await desktopIpc.room.createInviteRoom();
      if (!canSelectFirstRunRoom(result.snapshot.access.status)) {
        options.authFeedback.value = roomAccessFeedback(result.snapshot);
        return;
      }
      const roomName = result.snapshot.room?.displayName
        || result.snapshot.room?.name
        || result.code;
      options.repoStatus.value = null;
      options.openRoomSnapshot(result.snapshot, {
        displayName: roomName,
        kind: "room",
        rootPath: null,
        meta: result.code,
      });
      firstRunInviteCode.value = result.code;
      firstRunRoomSelected.value = true;
    } catch (error) {
      options.authFeedback.value = error instanceof Error
        ? error.message
        : "LetAgents could not create a room.";
    } finally {
      options.loading.value = false;
    }
  }

  function goBackFirstRun(): void {
    options.mcpInstallFeedback.value = null;
    options.authFeedback.value = null;
    options.setupLoadError.value = null;

    if (options.firstRunStage.value === "agent") {
      options.firstRunStage.value = "room";
      return;
    }

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
      if (!desktopIpc.setup) {
        throw new Error("Restart LetAgents Desktop so setup can install MCP automatically.");
      }

      if (desktopIpc.setup.installMcpServer) {
        const failedAttempts = new Map<DesktopMcpInstallTargetId, string>();
        const revealDelayMs = mcpInstallRevealDelay(options.mcpInstallRevealDelayMs);

        // Install and verify each target independently so the UI can reveal
        // real completion state one app at a time without replacing the view.
        for (const targetId of targetIds) {
          try {
            const result = await desktopIpc.setup.installMcpServer(targetId);
            options.mcpInstallState.value = result.installState;
            if (!result.success || result.target.status !== "installed") {
              failedAttempts.set(targetId, result.message);
            }
          } catch (error) {
            failedAttempts.set(
              targetId,
              error instanceof Error
                ? error.message
                : "The app's MCP settings could not be updated.",
            );
          }

          await nextTick();
          await waitForMcpInstallReveal(revealDelayMs);
        }

        // Reconcile once more after the sequence in case an IPC response was
        // interrupted after its write completed.
        try {
          options.mcpInstallState.value = await desktopIpc.setup.getMcpInstallState();
        } catch {
          // Each successful target response already contains verified state.
        }
        options.selectedMcpTargetIds.value = targetIds;

        const selectedTargets = visibleMcpInstallState.value.targets.filter((target) =>
          targetIds.includes(target.id)
        );
        // The reread config status is authoritative. An IPC response can fail
        // after its atomic write completed, so do not override a verified
        // installed state with the earlier transport error.
        const unverifiedTargets = selectedTargets.filter(
          (target) => target.status !== "installed",
        );
        if (unverifiedTargets.length) {
          const successfulNames = selectedTargets
            .filter((target) => !unverifiedTargets.includes(target))
            .map((target) => target.name)
            .join(", ");
          const failedNames = unverifiedTargets.map((target) => target.name).join(", ");
          const firstFailure = unverifiedTargets
            .map((target) => failedAttempts.get(target.id) || target.configIssue)
            .find(Boolean);
          options.mcpInstallFeedback.value =
            `${successfulNames ? `${successfulNames} installed. ` : ""}Couldn't install ${failedNames}. ${firstFailure || "Check the app's config and try again."}`;
          options.mcpWizardStep.value = "install";
          return;
        }

        options.mcpInstallFeedback.value = "MCP installed. Restart your agent apps to load it.";
        options.mcpWizardStep.value = "done";
        return;
      }

      // Compatibility fallback for an older preload bridge.
      const result = await desktopIpc.setup.installMcpServers(targetIds);
      options.mcpInstallState.value = result.installState;
      options.selectedMcpTargetIds.value = result.targets.map((target) => target.id);
      options.mcpInstallFeedback.value = result.message;
      if (!result.success || result.targets.some((target) => target.status !== "installed")) {
        options.mcpWizardStep.value = "install";
        return;
      }
      options.mcpWizardStep.value = "done";
    } catch (error) {
      options.mcpInstallFeedback.value = error instanceof Error
        ? error.message
        : "LetAgents could not update these apps' MCP settings.";
      // IPC/runtime failures should not leave the UI showing stale pre-install
      // state when one or more config writes may already have succeeded.
      try {
        if (desktopIpc.setup) {
          options.mcpInstallState.value = await desktopIpc.setup.getMcpInstallState();
        }
      } catch {
        // Preserve the original installation error; a retry will reread again.
      }
      options.mcpWizardStep.value = "install";
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
    options.firstRunStage.value = "room";
  }

  function continueToFirstAgent(): void {
    if (!firstRunRoomSelected.value) return;
    const availableTargets = visibleMcpInstallState.value.targets.filter((target) =>
      options.selectedMcpTargetIds.value.includes(target.id) && target.status === "installed"
    );
    const selectedStillAvailable = availableTargets.some(
      (target) => target.id === firstRunAgentTargetId.value,
    );
    if (!selectedStillAvailable) {
      firstRunAgentTargetId.value = availableTargets[0]?.id || null;
    }
    options.authFeedback.value = null;
    options.firstRunStage.value = "agent";
  }

  function selectFirstAgentTarget(targetId: DesktopMcpInstallTargetId): void {
    const available = visibleMcpInstallState.value.targets.some((target) =>
      target.id === targetId
      && target.status === "installed"
      && options.selectedMcpTargetIds.value.includes(target.id)
    );
    if (available) firstRunAgentTargetId.value = targetId;
  }

  async function finishFirstRunOnboarding(
    preferredProviderId: DesktopMcpInstallTargetId | null = null,
  ): Promise<boolean> {
    const roomIdentifier = firstRunRoomSelected.value
      ? options.pinnedRoom.value.roomIdentifier
      : null;

    options.mcpInstallBusy.value = true;
    options.mcpInstallFeedback.value = null;
    options.setupLoadError.value = null;
    try {
      if (!desktopIpc.setup) {
        throw new Error("Restart LetAgents Desktop so setup can finish.");
      }
      if (roomIdentifier) {
        if (!desktopIpc.room?.getSnapshot) {
          throw new Error("Restart LetAgents Desktop so the selected room can be verified.");
        }
        const snapshot = await desktopIpc.room.getSnapshot(roomIdentifier);
        if (snapshot.access.status !== "ready") {
          firstRunRoomSelected.value = snapshot.access.status === "auth_required";
          options.openRoomSnapshot(snapshot, firstRunRoomOpenOptions(snapshot, options));
          options.authFeedback.value = roomAccessFeedback(snapshot);
          return false;
        }
        options.openRoomSnapshot(snapshot, firstRunRoomOpenOptions(snapshot, options));
      }
      options.mcpInstallState.value = await desktopIpc.setup.completeMcpOnboarding();
      await options.refresh();
      options.activeEntry.value = options.pinnedRoom.value;
      if (roomIdentifier && preferredProviderId) {
        options.requestFirstAgent?.(preferredProviderId);
      }
      return true;
    } catch (error) {
      options.authFeedback.value = error instanceof Error ? error.message : "Could not close setup.";
      return false;
    } finally {
      options.mcpInstallBusy.value = false;
    }
  }

  return {
    clearMcpTargetSelection,
    completeMcpOnboarding,
    continueToFirstAgent,
    continueMcpOnboarding,
    continueToRoomConfirmation,
    createFirstRunInviteRoom,
    finishFirstRunOnboarding,
    firstRunAgentTargetId,
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
    selectFirstAgentTarget,
    selectMcpTarget,
    setupApiAvailable,
    showFirstRunGate,
    showFirstRunSplash,
    startFirstRunSetup,
    visibleMcpInstallState,
  };
}

function mcpInstallRevealDelay(overrideMs?: number): number {
  if (overrideMs !== undefined) return Math.max(0, overrideMs);
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return 0;
  }
  return defaultMcpInstallRevealDelayMs;
}

async function waitForMcpInstallReveal(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function waitForInitialRefresh(
  refresh: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      refresh(),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function canSelectFirstRunRoom(status: DesktopRoomAccess["status"]): boolean {
  return status === "ready" || status === "auth_required";
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
