import type { ChatScrollPosition } from "../../domain/chat-scroll";
import { nextTick, watch } from "vue";
import type { DesktopRoomStorageState } from "../../../../electron/ipc-types";
import { initialMessageInspectorRequest } from "../../domain/room-message-reveal";
import { rememberEnvironmentPanelOpen, rememberGitHubEventsVisible } from "../../components/desktop/content/room-shell/preferences";
import { exportRoomChat } from "../../components/desktop/content/room-shell/roomExport";
import type { RoomTabId } from "../../components/desktop/content/room-shell/types";
import { desktopIpc } from "../../ipc/index.js";
import type { RoomShellContextOf } from "./context";

/** Tabs, tool panels, room storage, message reveal, and room links. */
export function useRoomShellToolActions(context: unknown) {
  const {
    actionPanelOpen, activeTab, activityHistoryRequest, addAgentModalOpen, agentInspectorCompact,
    agentInspectorInitialTab, artifactTimelineTaskFilterId, boardSelectedTaskId,
    copyRoomLinkToClipboard, emit, environmentPanelOpen, githubEventsVisible, props,
    pushActionToast, refreshedEnvironmentRepoStatus, revealedMessageId, roomActiveTabStorageKey,
    rulesOpen, storageBusy, storageFeedback, supervisorEntries,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellState">;
  const app = context as RoomShellContextOf<"pending">;
  let environmentRepoStatusRefreshRequestId = 0;
  function openBoardTask(taskId: string): void {
    boardSelectedTaskId.value = taskId;
    activeTab.value = "board";
  }

  function rememberChatScrollPosition(scrollTop: ChatScrollPosition): void {
    emit("chat-scroll-position", props.room.identifier, scrollTop);
  }

  function selectTab(tabId: RoomTabId): void {
    if (activeTab.value === tabId) return;
    if (tabId === "events" && !app.showEventsTab.value) return;
    if (app.isLocalRoom.value && tabId === "rooms") return;
    activeTab.value = tabId;
  }

  function rememberRoomActiveTab(roomIdentifier: string, tab: RoomTabId): void {
    try {
      window.localStorage.setItem(roomActiveTabStorageKey(roomIdentifier), tab);
    } catch {
      // Tab memory is only a convenience; navigation should still work when storage is blocked.
    }
  }

  function openArtifactsForTask(taskId: string): void {
    boardSelectedTaskId.value = taskId;
    artifactTimelineTaskFilterId.value = taskId;
    activityHistoryRequest.value += 1;
    activeTab.value = "activity";
  }

  function toggleGitHubEventsVisible(): void {
    githubEventsVisible.value = !githubEventsVisible.value;
    rememberGitHubEventsVisible(props.room.identifier, githubEventsVisible.value);
  }

  function setEnvironmentPanelOpen(open: boolean): void {
    environmentPanelOpen.value = open;
    rememberEnvironmentPanelOpen(props.room.identifier, open);
    if (open) void refreshEnvironmentRepoStatus();
  }

  async function refreshEnvironmentRepoStatus(): Promise<void> {
    const rootPath = props.repoStatus.rootPath?.trim();
    if (!rootPath || !desktopIpc.repos?.getStatus) return;
    const requestId = ++environmentRepoStatusRefreshRequestId;
    const nextStatus = await desktopIpc.repos.getStatus(rootPath).catch(() => null);
    if (requestId !== environmentRepoStatusRefreshRequestId || !nextStatus) return;
    if (nextStatus.rootPath !== props.repoStatus.rootPath) return;
    refreshedEnvironmentRepoStatus.value = nextStatus;
  }

  async function setRoomStorageMode(mode: DesktopRoomStorageState["overrideMode"]): Promise<void> {
    const bridge = desktopIpc.chatStorage;
    if (!bridge?.setRoomMode || storageBusy.value) return;
    if (mode === "local" && !props.storage.localRoom) {
      await forkRoomToLocal();
      return;
    }
    storageBusy.value = true;
    try {
      await bridge.setRoomMode(props.room.identifier, mode);
      const snapshot = await desktopIpc.room?.getSnapshot?.(props.room.identifier);
      emit("refresh-room", snapshot);
    } finally {
      storageBusy.value = false;
    }
  }

  async function forkRoomToLocal(): Promise<void> {
    const bridge = desktopIpc.chatStorage;
    if (!bridge?.forkRoomToLocal || storageBusy.value) return;
    const confirmed = window.confirm(
      "Switch this room to Local on this device? Desktop will import the current chat and board into local storage, keep this same room visible, and keep new updates on this device until you publish.",
    );
    if (!confirmed) return;
    storageBusy.value = true;
    try {
      const result = await bridge.forkRoomToLocal(props.room.identifier);
      await desktopIpc.room?.stopStream?.(props.room.identifier);
      actionPanelOpen.value = false;
      emit("refresh-room", result.snapshot);
    } finally {
      storageBusy.value = false;
    }
  }

  async function publishLocalRoom(): Promise<void> {
    const bridge = desktopIpc.chatStorage;
    if (!bridge?.publishLocalRoom || storageBusy.value) return;
    storageBusy.value = true;
    storageFeedback.value = null;
    const roomIdentifier = props.room.identifier;
    try {
      const result = await bridge.publishLocalRoom(roomIdentifier);
      if (props.room.identifier !== roomIdentifier) return;
      const snapshot = await desktopIpc.room?.getSnapshot?.(roomIdentifier);
      if (props.room.identifier !== roomIdentifier) return;
      emit("refresh-room", snapshot);
      await nextTick();
      if (props.room.identifier !== roomIdentifier && props.room.identifier !== snapshot?.roomIdentifier) return;
      const skipped = result.skippedCount + result.skippedTaskCount;
      storageFeedback.value = { error: false, message: `Published ${result.syncedCount} messages and ${result.syncedTaskCount} tasks.${skipped ? ` ${skipped} items remain local and can be retried.` : ""} Storage remains Local until you choose Cloud.` };
    } catch (error) {
      if (props.room.identifier === roomIdentifier) storageFeedback.value = {
        error: true,
        message: error instanceof Error ? error.message : "Local chat could not be published. Your history is still on this device.",
      };
    } finally {
      storageBusy.value = false;
    }
  }

  function toggleSearchTool(): void {
    if (!app.searchOpen.value) {
      actionPanelOpen.value = false;
    }
    app.toggleSearchOpen();
  }

  function toggleActionPanel(): void {
    const nextOpen = !actionPanelOpen.value;
    actionPanelOpen.value = nextOpen;
    if (nextOpen) {
      app.closeSearch();
    }
  }

  function closeActionPanel(): void {
    actionPanelOpen.value = false;
  }

  function openRules(): void {
    rulesOpen.value = true;
    actionPanelOpen.value = false;
  }

  function openAddAgentModal(): void {
    if (props.projectRoom && !props.durableProjectRootPath) {
      pushActionToast("Connect this room to its local project before adding an agent.", "info", 6_000);
      return;
    }
    addAgentModalOpen.value = true;
  }

  async function revealRoomMessage(messageId: string): Promise<void> {
    if (messageId.startsWith("desktop-initial-message:")) {
      const request = initialMessageInspectorRequest(messageId, props.room.identifier, supervisorEntries.value);
      if (!request) {
        emit("message-reveal-unavailable", messageId);
        return;
      }
      app.openAgentDetailRequest(request);
      agentInspectorInitialTab.value = "work";
      app.selectAgentInspectorWorkSource(messageId);
      return;
    }
    const outcome = await app.revealMessage(messageId);
    if (outcome !== "revealed") {
      emit("message-reveal-unavailable", messageId, outcome);
      return;
    }
    // Repeated links to the same message need a new reactive edge.
    revealedMessageId.value = null;
    await nextTick();
    revealedMessageId.value = messageId;
  }

  async function revealRecordedWorkMessage(messageId: string): Promise<void> {
    if (!messageId.trim()) return;
    activeTab.value = "chat";
    await revealRoomMessage(messageId);
  }

  /** A wake message is an ordinary room message: show it in the chat. */
  async function revealWakeMessage(messageId: string): Promise<void> {
    activeTab.value = "chat";
    await revealRoomMessage(messageId);
    if (agentInspectorCompact.value) app.closeAgentDetail();
  }

  /** The room message a shared live view says the agent is answering. */
  async function revealSharedLiveRequest(messageId: string): Promise<void> {
    activeTab.value = "chat";
    await revealRoomMessage(messageId);
    if (agentInspectorCompact.value) app.closeAgentDetail();
  }

  function openAgentWorktree(rootPath: string): void {
    addAgentModalOpen.value = false;
    emit("choose-worktree", rootPath);
  }

  async function copyRoomLink(): Promise<void> {
    await copyRoomLinkToClipboard(app.roomUrl.value);
  }

  function exportChat(): void {
    exportRoomChat(props.room, app.visibleMessages.value, app.roomAttentionResponseNames.value);
  }
  return {
    openBoardTask, rememberChatScrollPosition, selectTab, rememberRoomActiveTab,
    openArtifactsForTask, toggleGitHubEventsVisible, setEnvironmentPanelOpen,
    refreshEnvironmentRepoStatus, setRoomStorageMode, forkRoomToLocal, publishLocalRoom,
    toggleSearchTool, toggleActionPanel, closeActionPanel, openRules, openAddAgentModal,
    revealRoomMessage, revealRecordedWorkMessage, revealWakeMessage, revealSharedLiveRequest,
    openAgentWorktree, copyRoomLink, exportChat,
  };
}

/** Clear storage feedback when the room changes. */
export function useRoomShellStorageWatcher(context: unknown) {
  const {
    props, storageFeedback,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellState">;
  watch(() => props.room.identifier, () => { storageFeedback.value = null; });
}
