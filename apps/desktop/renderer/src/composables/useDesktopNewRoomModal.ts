import { computed, ref } from "vue";
import type { DesktopRepoRoomSelection, DesktopRoomSnapshot, RepoStatus } from "../../../electron/ipc-types";
import { copyTextToClipboard } from "../domain/clipboard";
import { normalizeJoinRoomInput, validateJoinRoomInput } from "../domain/join-room-input";
import { rootPathLabel, type RecentRootRoomKind } from "../domain/sidebar-rooms";
import { desktopIpc } from "../ipc/index.js";

export type NewRoomStep =
  | "chooser"
  | "project"
  | "standalone"
  | "join"
  | "working"
  | "success"
  | "error";

export type NewRoomStorageChoice = "cloud" | "local";
export type NewRoomActiveAction =
  | "pick_project"
  | "confirm_project"
  | "create_standalone"
  | "join"
  | "open_success"
  | "copy_code"
  | null;

export type NewRoomSuccessKind = "shared" | "local" | "project" | "joined";

export interface NewRoomSuccessState {
  kind: NewRoomSuccessKind;
  roomName: string;
  storageLabel: string;
  inviteCode: string | null;
  snapshot: DesktopRoomSnapshot;
  openOptions: OpenRoomOptions;
  repoStatus?: RepoStatus | null;
}

interface OpenRoomOptions {
  displayName?: string | null;
  kind?: RecentRootRoomKind | null;
  rootPath?: string | null;
  meta?: string | null;
}

interface DesktopNewRoomModalOptions {
  openRoomSnapshot: (snapshot: DesktopRoomSnapshot, options?: OpenRoomOptions) => void;
  setRepoStatus: (status: RepoStatus | null) => void;
  getDefaultStorageMode?: () => NewRoomStorageChoice;
}

export interface PendingProjectRoomSelection {
  folderLabel: string;
  repoPath: string | null;
  repoStatus: RepoStatus | null;
  roomIdentifier: string;
  roomName: string;
  snapshot: DesktopRoomSnapshot;
  source: DesktopRepoRoomSelection["source"];
  sourceLabel: string;
  warning: string | null;
}

function generateDefaultRoomName(): string {
  const stamp = new Date();
  const hh = String(stamp.getHours()).padStart(2, "0");
  const mm = String(stamp.getMinutes()).padStart(2, "0");
  return `Room ${hh}:${mm}`;
}

export function useDesktopNewRoomModal(options: DesktopNewRoomModalOptions) {
  const newRoomModalOpen = ref(false);
  const newRoomStep = ref<NewRoomStep>("chooser");
  const newRoomReturnStep = ref<Exclude<NewRoomStep, "working" | "success" | "error">>("chooser");
  const newRoomBusy = ref(false);
  const newRoomActiveAction = ref<NewRoomActiveAction>(null);
  const newRoomFeedback = ref<string | null>(null);
  const newRoomFeedbackState = ref<"info" | "error" | "success">("info");
  const newRoomJoinCode = ref("");
  const newRoomJoinError = ref<string | null>(null);
  const newRoomName = ref("");
  const newRoomStorage = ref<NewRoomStorageChoice>("cloud");
  const newRoomProjectSelection = ref<PendingProjectRoomSelection | null>(null);
  const newRoomSuccess = ref<NewRoomSuccessState | null>(null);
  const newRoomStatusMessage = ref<string | null>(null);

  const canSubmitJoin = computed(() => {
    const validation = validateJoinRoomInput(newRoomJoinCode.value);
    return Boolean(validation.normalized) && !validation.error;
  });
  const canSubmitStandalone = computed(() => !newRoomBusy.value);

  function resetTransientState(): void {
    newRoomBusy.value = false;
    newRoomActiveAction.value = null;
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";
    newRoomJoinError.value = null;
    newRoomStatusMessage.value = null;
  }

  function selectNewRoomEntry() {
    newRoomModalOpen.value = true;
    newRoomStep.value = "chooser";
    newRoomReturnStep.value = "chooser";
    newRoomJoinCode.value = "";
    newRoomJoinError.value = null;
    newRoomName.value = generateDefaultRoomName();
    newRoomStorage.value = options.getDefaultStorageMode?.() === "local" ? "local" : "cloud";
    newRoomProjectSelection.value = null;
    newRoomSuccess.value = null;
    resetTransientState();
  }

  function closeNewRoomModal(): void {
    if (newRoomBusy.value) return;
    newRoomModalOpen.value = false;
    newRoomStep.value = "chooser";
    newRoomJoinCode.value = "";
    newRoomJoinError.value = null;
    newRoomName.value = "";
    newRoomProjectSelection.value = null;
    newRoomSuccess.value = null;
    resetTransientState();
  }

  function goToChooser(): void {
    if (newRoomBusy.value) return;
    newRoomStep.value = "chooser";
    newRoomReturnStep.value = "chooser";
    newRoomProjectSelection.value = null;
    newRoomSuccess.value = null;
    resetTransientState();
  }

  function chooseProjectIntent(): void {
    if (newRoomBusy.value) return;
    newRoomStep.value = "project";
    newRoomReturnStep.value = "project";
    newRoomSuccess.value = null;
    resetTransientState();
  }

  function chooseStandaloneIntent(): void {
    if (newRoomBusy.value) return;
    newRoomStep.value = "standalone";
    newRoomReturnStep.value = "standalone";
    if (!newRoomName.value.trim()) {
      newRoomName.value = generateDefaultRoomName();
    }
    newRoomStorage.value = options.getDefaultStorageMode?.() === "local" ? "local" : newRoomStorage.value;
    newRoomSuccess.value = null;
    resetTransientState();
  }

  function chooseJoinIntent(): void {
    if (newRoomBusy.value) return;
    newRoomStep.value = "join";
    newRoomReturnStep.value = "join";
    newRoomSuccess.value = null;
    resetTransientState();
  }

  function backFromSubstep(): void {
    if (newRoomBusy.value) return;
    if (newRoomStep.value === "error") {
      newRoomStep.value = newRoomReturnStep.value;
      resetTransientState();
      return;
    }
    goToChooser();
  }

  function retryLastAction(): void {
    if (newRoomBusy.value) return;
    const step = newRoomReturnStep.value;
    newRoomStep.value = step;
    resetTransientState();
    if (step === "project" && newRoomProjectSelection.value) {
      return;
    }
    if (step === "standalone") {
      void createStandaloneRoom();
      return;
    }
    if (step === "join") {
      void joinRoomCodeFromModal();
    }
  }

  async function createInviteRoom(): Promise<void> {
    newRoomStorage.value = "cloud";
    await createStandaloneRoom();
  }

  async function createLocalRoomFromModal(): Promise<void> {
    newRoomStorage.value = "local";
    await createStandaloneRoom();
  }

  async function createStandaloneRoom(): Promise<void> {
    if (newRoomBusy.value) return;
    const displayName = newRoomName.value.trim() || generateDefaultRoomName();
    newRoomName.value = displayName;
    newRoomBusy.value = true;
    newRoomActiveAction.value = "create_standalone";
    newRoomReturnStep.value = "standalone";
    newRoomStep.value = "working";
    newRoomStatusMessage.value =
      newRoomStorage.value === "local" ? "Creating local room..." : "Creating shared room...";
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";

    try {
      if (newRoomStorage.value === "local") {
        const bridge = desktopIpc.chatStorage;
        if (!bridge?.createLocalRoom) {
          throw new Error("Restart LetAgents Desktop to enable local rooms.");
        }
        const result = await bridge.createLocalRoom({ displayName });
        newRoomSuccess.value = {
          kind: "local",
          roomName: result.snapshot.room?.displayName || displayName,
          storageLabel: "Local / private on this device",
          inviteCode: null,
          snapshot: result.snapshot,
          openOptions: {
            displayName,
            kind: "room",
            rootPath: null,
            meta: "Local on this device",
          },
        };
      } else {
        const result = await desktopIpc.room.createInviteRoom();
        let snapshot = result.snapshot;
        let roomName =
          snapshot.room?.displayName ||
          snapshot.room?.name ||
          result.code;
        let namingWarning: string | null = null;
        const rename = desktopIpc.room.rename;
        if (rename && displayName) {
          try {
            const renamed = await rename(result.roomIdentifier, displayName);
            roomName = renamed.displayName || renamed.name || displayName;
            snapshot = {
              ...snapshot,
              room: snapshot.room
                ? {
                    ...snapshot.room,
                    displayName: roomName,
                    name: renamed.name || roomName,
                  }
                : snapshot.room,
            };
          } catch (error) {
            namingWarning =
              error instanceof Error
                ? `Room created, but renaming failed: ${error.message}`
                : "Room created, but the requested name could not be applied.";
            roomName =
              snapshot.room?.displayName ||
              snapshot.room?.name ||
              result.code;
          }
        } else if (displayName) {
          roomName = displayName;
        }
        newRoomSuccess.value = {
          kind: "shared",
          roomName,
          storageLabel: "Cloud / shared",
          inviteCode: result.code,
          snapshot,
          openOptions: {
            displayName: roomName,
            kind: "room",
            rootPath: null,
            meta: result.code || "Shared room",
          },
        };
        if (namingWarning) {
          newRoomFeedback.value = namingWarning;
          newRoomFeedbackState.value = "info";
        } else {
          newRoomFeedback.value = null;
          newRoomFeedbackState.value = "success";
        }
      }
      newRoomStep.value = "success";
      if (newRoomStorage.value === "local") {
        newRoomFeedback.value = null;
        newRoomFeedbackState.value = "success";
      }
      newRoomJoinCode.value = "";
      newRoomProjectSelection.value = null;
    } catch (error) {
      newRoomFeedback.value =
        error instanceof Error
          ? error.message
          : newRoomStorage.value === "local"
            ? "LetAgents could not create a local room."
            : "LetAgents could not create a shared room.";
      newRoomFeedbackState.value = "error";
      newRoomStep.value = "error";
    } finally {
      newRoomBusy.value = false;
      newRoomActiveAction.value = null;
      newRoomStatusMessage.value = null;
    }
  }

  async function openProjectRoomFromModal(): Promise<void> {
    if (newRoomBusy.value) return;
    newRoomBusy.value = true;
    newRoomActiveAction.value = "pick_project";
    newRoomReturnStep.value = "project";
    newRoomStep.value = "working";
    newRoomStatusMessage.value = "Opening the project picker...";
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";
    try {
      const result = await desktopIpc.repos.pickRoom();
      if (result.canceled) {
        newRoomStep.value = "project";
        newRoomStatusMessage.value = null;
        return;
      }
      if (result.error || !result.snapshot) {
        newRoomFeedback.value = result.error || "LetAgents could not open a room from that folder.";
        newRoomFeedbackState.value = "error";
        newRoomStep.value = "error";
        return;
      }
      newRoomProjectSelection.value = projectSelectionFromResult(result, result.snapshot);
      newRoomFeedback.value = result.warning || null;
      newRoomFeedbackState.value = result.warning ? "info" : "success";
      newRoomStep.value = "project";
    } catch (error) {
      newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not open the project picker.";
      newRoomFeedbackState.value = "error";
      newRoomStep.value = "error";
    } finally {
      newRoomBusy.value = false;
      newRoomActiveAction.value = null;
      newRoomStatusMessage.value = null;
    }
  }

  function confirmProjectRoomFromModal(): void {
    const selection = newRoomProjectSelection.value;
    if (!selection || newRoomBusy.value) return;
    newRoomActiveAction.value = "confirm_project";
    newRoomSuccess.value = {
      kind: "project",
      roomName: selection.roomName,
      storageLabel: selection.sourceLabel,
      inviteCode: null,
      snapshot: selection.snapshot,
      repoStatus: selection.repoStatus,
      openOptions: {
        displayName: selection.folderLabel,
        kind: "project",
        rootPath: selection.repoPath,
        meta: selection.repoStatus?.branch || rootPathLabel(selection.repoPath) || selection.source || null,
      },
    };
    openSuccessRoom();
  }

  async function joinRoomCodeFromModal(): Promise<void> {
    if (newRoomBusy.value) return;
    const validation = validateJoinRoomInput(newRoomJoinCode.value);
    if (!validation.normalized) {
      newRoomJoinError.value = validation.error;
      newRoomFeedback.value = validation.error;
      newRoomFeedbackState.value = "error";
      return;
    }
    newRoomJoinError.value = null;
    newRoomJoinCode.value = validation.normalized;
    newRoomBusy.value = true;
    newRoomActiveAction.value = "join";
    newRoomReturnStep.value = "join";
    newRoomStep.value = "working";
    newRoomStatusMessage.value = "Joining room...";
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";
    try {
      const snapshot = await desktopIpc.room.getSnapshot(validation.normalized);
      if (snapshot.access.status !== "ready") {
        newRoomFeedback.value = snapshot.access.message || "You do not have access to that room.";
        newRoomFeedbackState.value = "error";
        newRoomStep.value = "error";
        return;
      }
      const roomName =
        snapshot.room?.displayName ||
        snapshot.room?.name ||
        snapshot.room?.code ||
        validation.normalized;
      newRoomSuccess.value = {
        kind: "joined",
        roomName,
        storageLabel: snapshot.room?.code ? `Invite ${snapshot.room.code}` : "Joined room",
        inviteCode: snapshot.room?.code || (looksLikeInviteCodeValue(validation.normalized) ? validation.normalized : null),
        snapshot,
        openOptions: {
          kind: "room",
          rootPath: null,
          meta: snapshot.room?.code || "Joined room",
        },
      };
      openSuccessRoom();
    } catch (error) {
      newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not join that room.";
      newRoomFeedbackState.value = "error";
      newRoomStep.value = "error";
    } finally {
      newRoomBusy.value = false;
      newRoomActiveAction.value = null;
      newRoomStatusMessage.value = null;
    }
  }

  function openSuccessRoom(): void {
    const success = newRoomSuccess.value;
    if (!success) return;
    newRoomActiveAction.value = "open_success";
    if (success.repoStatus) {
      options.setRepoStatus(success.repoStatus);
    }
    options.openRoomSnapshot(success.snapshot, success.openOptions);
    newRoomModalOpen.value = false;
    newRoomStep.value = "chooser";
    newRoomJoinCode.value = "";
    newRoomProjectSelection.value = null;
    newRoomSuccess.value = null;
    resetTransientState();
  }

  function dismissSuccess(): void {
    if (newRoomBusy.value) return;
    newRoomModalOpen.value = false;
    newRoomStep.value = "chooser";
    newRoomSuccess.value = null;
    resetTransientState();
  }

  async function copyInviteCode(): Promise<boolean> {
    const code = newRoomSuccess.value?.inviteCode;
    if (!code) return false;
    newRoomActiveAction.value = "copy_code";
    try {
      const copied = await copyTextToClipboard(code);
      if (copied) {
        newRoomFeedback.value = "Invite code copied.";
        newRoomFeedbackState.value = "success";
        return true;
      }
      newRoomFeedback.value = "Could not copy the invite code. Select it and copy manually.";
      newRoomFeedbackState.value = "error";
      return false;
    } finally {
      newRoomActiveAction.value = null;
    }
  }

  return {
    backFromSubstep,
    canSubmitJoin,
    canSubmitStandalone,
    chooseJoinIntent,
    chooseProjectIntent,
    chooseStandaloneIntent,
    closeNewRoomModal,
    confirmProjectRoomFromModal,
    copyInviteCode,
    createInviteRoom,
    createLocalRoomFromModal,
    createStandaloneRoom,
    dismissSuccess,
    goToChooser,
    joinRoomCodeFromModal,
    newRoomActiveAction,
    newRoomBusy,
    newRoomFeedback,
    newRoomFeedbackState,
    newRoomJoinCode,
    newRoomJoinError,
    newRoomModalOpen,
    newRoomName,
    newRoomProjectSelection,
    newRoomStatusMessage,
    newRoomStep,
    newRoomStorage,
    newRoomSuccess,
    openProjectRoomFromModal,
    openSuccessRoom,
    retryLastAction,
    selectNewRoomEntry,
  };
}

function looksLikeInviteCodeValue(value: string): boolean {
  return /^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/.test(value.trim().toUpperCase());
}

function projectSelectionFromResult(
  result: DesktopRepoRoomSelection,
  snapshot: DesktopRoomSnapshot
): PendingProjectRoomSelection {
  const roomIdentifier = snapshot.room?.identifier || snapshot.roomIdentifier || result.roomIdentifier || "Room";
  const roomName = snapshot.room?.displayName || snapshot.room?.name || roomIdentifier;
  return {
    folderLabel: rootPathLabel(result.repoPath) || result.repoPath || "Selected project folder",
    repoPath: result.repoPath,
    repoStatus: result.repoStatus,
    roomIdentifier,
    roomName,
    snapshot,
    source: result.source,
    sourceLabel: projectRoomSourceLabel(result.source),
    warning: result.warning,
  };
}

function projectRoomSourceLabel(source: DesktopRepoRoomSelection["source"]): string {
  if (source === "configured") return ".letagents.json";
  if (source === "git_remote") return "Git remote";
  if (source === "local_git") return "Local Git Room";
  if (source === "local_folder") return "Local folder";
  return "Project folder";
}
