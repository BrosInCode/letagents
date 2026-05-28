import { ref } from "vue";
import type { DesktopRoomSnapshot } from "../../../electron/ipc-types";
import { rootPathLabel } from "../domain/sidebar-rooms";

interface OpenRoomOptions {
  rootPath?: string | null;
  meta?: string | null;
}

interface DesktopNewRoomModalOptions {
  openRoomSnapshot: (snapshot: DesktopRoomSnapshot, options?: OpenRoomOptions) => void;
}

export function useDesktopNewRoomModal(options: DesktopNewRoomModalOptions) {
  const newRoomModalOpen = ref(false);
  const newRoomBusy = ref(false);
  const newRoomFeedback = ref<string | null>(null);
  const newRoomFeedbackState = ref<"info" | "error" | "success">("info");
  const newRoomJoinCode = ref("");

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
  }

  async function createInviteRoom(): Promise<void> {
    newRoomBusy.value = true;
    newRoomFeedback.value = "Creating invite room...";
    newRoomFeedbackState.value = "info";
    try {
      const result = await window.letagentsDesktop.room.createInviteRoom();
      options.openRoomSnapshot(result.snapshot);
      newRoomFeedback.value = `Invite room created. Join code: ${result.code}.`;
      newRoomFeedbackState.value = "success";
      newRoomJoinCode.value = "";
    } catch (error) {
      newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not create an invite room.";
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
      options.openRoomSnapshot(result.snapshot, {
        rootPath: result.repoPath,
        meta: rootPathLabel(result.repoPath) || result.source || null,
      });
      newRoomFeedback.value = result.warning
        ? `${result.warning} Room selected.`
        : "Project room selected.";
      newRoomFeedbackState.value = "success";
      newRoomModalOpen.value = false;
      newRoomJoinCode.value = "";
    } catch (error) {
      newRoomFeedback.value = error instanceof Error ? error.message : "LetAgents could not open the project picker.";
      newRoomFeedbackState.value = "error";
    } finally {
      newRoomBusy.value = false;
    }
  }

  async function joinRoomCodeFromModal(): Promise<void> {
    const roomCode = newRoomJoinCode.value.trim();
    if (!roomCode) return;
    newRoomBusy.value = true;
    newRoomFeedback.value = "Joining room...";
    newRoomFeedbackState.value = "info";
    try {
      const snapshot = await window.letagentsDesktop.room.getSnapshot(roomCode);
      options.openRoomSnapshot(snapshot, { meta: snapshot.room?.code || "Joined room" });
      newRoomFeedback.value = snapshot.access.status === "ready"
        ? "Room selected."
        : snapshot.access.message;
      newRoomFeedbackState.value = snapshot.access.status === "ready" ? "success" : "error";
      if (snapshot.access.status === "ready") {
        newRoomModalOpen.value = false;
        newRoomJoinCode.value = "";
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
    createInviteRoom,
    joinRoomCodeFromModal,
    newRoomBusy,
    newRoomFeedback,
    newRoomFeedbackState,
    newRoomJoinCode,
    newRoomModalOpen,
    openProjectRoomFromModal,
    selectNewRoomEntry,
  };
}
