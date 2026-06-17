import { ref } from "vue";
import type { DesktopRepoRoomSelection, DesktopRoomSnapshot, RepoStatus } from "../../../electron/ipc-types";
import { rootPathLabel, type RecentRootRoomKind } from "../domain/sidebar-rooms";

interface OpenRoomOptions {
  displayName?: string | null;
  kind?: RecentRootRoomKind | null;
  rootPath?: string | null;
  meta?: string | null;
}

interface DesktopNewRoomModalOptions {
  openRoomSnapshot: (snapshot: DesktopRoomSnapshot, options?: OpenRoomOptions) => void;
  setRepoStatus: (status: RepoStatus | null) => void;
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

export function useDesktopNewRoomModal(options: DesktopNewRoomModalOptions) {
  const newRoomModalOpen = ref(false);
  const newRoomBusy = ref(false);
  const newRoomFeedback = ref<string | null>(null);
  const newRoomFeedbackState = ref<"info" | "error" | "success">("info");
  const newRoomJoinCode = ref("");
  const newRoomProjectSelection = ref<PendingProjectRoomSelection | null>(null);

  function selectNewRoomEntry() {
    newRoomModalOpen.value = true;
    newRoomFeedback.value = null;
    newRoomFeedbackState.value = "info";
  }

  function closeNewRoomModal(): void {
    if (newRoomBusy.value) return;
    newRoomModalOpen.value = false;
    newRoomFeedback.value = null;
    newRoomJoinCode.value = "";
    newRoomProjectSelection.value = null;
  }

  async function createInviteRoom(): Promise<void> {
    newRoomBusy.value = true;
    newRoomFeedback.value = "Creating invite room...";
    newRoomFeedbackState.value = "info";
    try {
      const result = await window.letagentsDesktop.room.createInviteRoom();
      options.openRoomSnapshot(result.snapshot, {
        kind: "room",
        rootPath: null,
        meta: "Temporary room",
      });
      newRoomFeedback.value = `Invite room created. Join code: ${result.code}.`;
      newRoomFeedbackState.value = "success";
      newRoomJoinCode.value = "";
      newRoomProjectSelection.value = null;
    } catch (error) {
      newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not create an invite room.";
      newRoomFeedbackState.value = "error";
    } finally {
      newRoomBusy.value = false;
    }
  }

  async function createLocalRoomFromModal(): Promise<void> {
    const bridge = window.letagentsDesktop.chatStorage;
    if (!bridge?.createLocalRoom) {
      newRoomFeedback.value = "Restart LetAgents Desktop to enable local rooms.";
      newRoomFeedbackState.value = "error";
      return;
    }
    newRoomBusy.value = true;
    newRoomFeedback.value = "Creating local room...";
    newRoomFeedbackState.value = "info";
    try {
      const result = await bridge.createLocalRoom();
      options.openRoomSnapshot(result.snapshot, {
        kind: "room",
        rootPath: null,
        meta: "Local on this device",
      });
      newRoomFeedback.value = "Local room created.";
      newRoomFeedbackState.value = "success";
      newRoomModalOpen.value = false;
      newRoomJoinCode.value = "";
      newRoomProjectSelection.value = null;
    } catch (error) {
      newRoomFeedback.value =
        error instanceof Error
          ? error.message
          : "LetAgents could not create a local room.";
      newRoomFeedbackState.value = "error";
    } finally {
      newRoomBusy.value = false;
    }
  }

  async function openProjectRoomFromModal(): Promise<void> {
    newRoomBusy.value = true;
    newRoomFeedback.value = "Opening the project picker...";
    newRoomFeedbackState.value = "info";
    try {
      const result = await window.letagentsDesktop.repos.pickRoom();
      if (result.canceled) {
        newRoomFeedback.value = null;
        return;
      }
      if (result.error || !result.snapshot) {
        newRoomFeedback.value = result.error || "LetAgents could not open a room from that folder.";
        newRoomFeedbackState.value = "error";
        return;
      }
      newRoomProjectSelection.value = projectSelectionFromResult(result, result.snapshot);
      newRoomFeedback.value = result.warning || null;
      newRoomFeedbackState.value = result.warning ? "info" : "success";
    } catch (error) {
      newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not open the project picker.";
      newRoomFeedbackState.value = "error";
    } finally {
      newRoomBusy.value = false;
    }
  }

  function confirmProjectRoomFromModal(): void {
    const selection = newRoomProjectSelection.value;
    if (!selection) return;
    options.setRepoStatus(selection.repoStatus);
    options.openRoomSnapshot(selection.snapshot, {
      displayName: selection.folderLabel,
      kind: "project",
      rootPath: selection.repoPath,
      meta: selection.repoStatus?.branch || rootPathLabel(selection.repoPath) || selection.source || null,
    });
    newRoomModalOpen.value = false;
    newRoomFeedback.value = null;
    newRoomJoinCode.value = "";
    newRoomProjectSelection.value = null;
  }

  async function joinRoomCodeFromModal(): Promise<void> {
    const roomCode = newRoomJoinCode.value.trim();
    if (!roomCode) return;
    newRoomBusy.value = true;
    newRoomFeedback.value = "Joining room...";
    newRoomFeedbackState.value = "info";
    try {
      const snapshot = await window.letagentsDesktop.room.getSnapshot(roomCode);
      options.openRoomSnapshot(snapshot, {
        kind: "room",
        rootPath: null,
        meta: snapshot.room?.code || "Joined room",
      });
      newRoomFeedback.value = snapshot.access.status === "ready"
        ? "Room selected."
        : snapshot.access.message;
      newRoomFeedbackState.value = snapshot.access.status === "ready" ? "success" : "error";
      if (snapshot.access.status === "ready") {
        newRoomModalOpen.value = false;
        newRoomJoinCode.value = "";
        newRoomProjectSelection.value = null;
      }
    } catch (error) {
      newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not join that room.";
      newRoomFeedbackState.value = "error";
    } finally {
      newRoomBusy.value = false;
    }
  }

  return {
    closeNewRoomModal,
    confirmProjectRoomFromModal,
    createInviteRoom,
    createLocalRoomFromModal,
    joinRoomCodeFromModal,
    newRoomBusy,
    newRoomFeedback,
    newRoomFeedbackState,
    newRoomJoinCode,
    newRoomModalOpen,
    newRoomProjectSelection,
    openProjectRoomFromModal,
    selectNewRoomEntry,
  };
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
  if (source === "local_fallback") return "Local fallback";
  return "Project folder";
}
