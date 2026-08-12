import type { IpcMain } from "electron";

import type {
  DesktopAccountRoomActionResult,
  DesktopAccountRoomEntry,
  DesktopAccountRoomListOptions,
  DesktopChatStorageSettings,
  DesktopDroppedAttachmentContent,
  DesktopFocusRoomConclusionDetails,
  DesktopFocusRoomMutationResult,
  DesktopFocusRoomSettingsPatch,
  DesktopGitHubEventsPage,
  DesktopGitHubEventsQuery,
  DesktopGitHubIntegrationActionResult,
  DesktopGitHubIntegrationStatus,
  DesktopInviteRoomCreation,
  DesktopLocalChatSyncResult,
  DesktopLocalRoomMutationResult,
  DesktopReasoningSessionDetail,
  DesktopRoomInfo,
  DesktopRoomLatestMessage,
  DesktopRoomLiveMetadata,
  DesktopRoomDeliveryRepair,
  DesktopRoomMessage,
  DesktopRoomMessagesPage,
  DesktopRoomSharedArtifact,
  DesktopRoomSnapshot,
  DesktopRoomStorageOverrideMode,
  DesktopRoomStorageState,
  DesktopRoomThreadInboxFilter,
  DesktopRoomThreadInboxPage,
  DesktopRoomThreadPage,
  DesktopRoomThreadReadResult,
  DesktopSendRoomMessageResult,
  DesktopStagedAttachment,
  DesktopTaskCreateInput,
  DesktopTaskLeaseActionInput,
  DesktopTaskMutationResult,
  DesktopTaskReviewLeaseActionInput,
  DesktopTaskReviewWorkerActionInput,
  DesktopTaskWorkerActionInput,
} from "../../ipc-types.js";
import type {
  DesktopBoardGovernanceAssignManagerInput,
  DesktopBoardGovernanceReleaseManagerInput,
  DesktopBoardGovernanceSetModeInput,
  DesktopBoardIntentDecisionInput,
} from "../../ipc-types/board-governance.js";
import {
  discardDesktopAttachment,
  pickAndStageDesktopAttachments,
  stageDroppedDesktopAttachmentContents,
} from "../attachments.js";
import {
  deliverDesktopRoomMessageToManagedAgents,
  repairDesktopRoomStreamManagedDelivery,
  startDesktopRoomStream,
  stopDesktopRoomStream,
} from "../room-stream.js";
import {
  addDesktopRoomTask,
  archiveDesktopFocusRoom,
  assignDesktopBoardManager,
  concludeDesktopFocusRoom,
  createDesktopAdHocFocusRoom,
  createDesktopInviteRoom,
  createDesktopLocalRoom,
  createDesktopTaskFocusRoom,
  decideDesktopBoardIntent,
  deleteDesktopAccountRoom,
  fetchRoomLiveMetadata,
  fetchRoomSnapshot,
  forkDesktopRoomToLocal,
  getDesktopBoardGovernance,
  getDesktopGitHubEvents,
  getDesktopGitHubIntegrationStatus,
  getDesktopReasoningSession,
  getDesktopRoomArtifacts,
  getDesktopRoomLatestMessages,
  getDesktopRoomMessage,
  getDesktopRoomMessageInfo,
  getDesktopRoomMessagesBefore,
  getDesktopRoomStorage,
  getDesktopRoomThread,
  getDesktopRoomThreads,
  leaveDesktopAccountRoom,
  listDesktopAccountRooms,
  markDesktopRoomThreadRead,
  openDesktopGitHubInstall,
  publishDesktopLocalRoom,
  readChatStorageSettings,
  releaseDesktopBoardManager,
  renameDesktopRoom,
  runDesktopRoomTaskReviewWorkerAction,
  runDesktopRoomTaskWorkerAction,
  sendDesktopRoomMessage,
  setChatStorageMode,
  setDesktopBoardManagerMode,
  setDesktopRoomStorageMode,
  syncDesktopLocalChatRoom,
  updateDesktopAccountRoom,
  updateDesktopFocusRoomSettings,
  updateDesktopRoomTask,
  updateDesktopRoomTaskLease,
  updateDesktopRoomTaskReviewLease,
} from "../rooms.js";
import { desktopSmokeBoardGovernance, isDesktopSmokeCheck } from "../smoke.js";

export function registerDesktopRoomIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle(
    "desktop:room:list-account-rooms",
    async (
      _event,
      options?: DesktopAccountRoomListOptions,
    ): Promise<DesktopAccountRoomEntry[]> => listDesktopAccountRooms(options),
  );
  targetIpcMain.handle(
    "desktop:room:update-account-room",
    async (
      _event,
      roomIdentifier: string,
      updates: { pinned?: boolean; archived?: boolean },
    ): Promise<DesktopAccountRoomActionResult> =>
      updateDesktopAccountRoom(roomIdentifier, updates),
  );
  targetIpcMain.handle(
    "desktop:room:leave-account-room",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopAccountRoomActionResult> =>
      leaveDesktopAccountRoom(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:room:delete-account-room",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopAccountRoomActionResult> =>
      deleteDesktopAccountRoom(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:room:get-snapshot",
    async (
      _event,
      roomIdentifier?: string | null,
    ): Promise<DesktopRoomSnapshot> => fetchRoomSnapshot(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:room:get-live-metadata",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopRoomLiveMetadata> => fetchRoomLiveMetadata(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:room:get-latest-messages",
    async (
      _event,
      roomIdentifiers: string[],
    ): Promise<DesktopRoomLatestMessage[]> =>
      getDesktopRoomLatestMessages(Array.isArray(roomIdentifiers) ? roomIdentifiers : []),
  );
  targetIpcMain.handle(
    "desktop:room:get-message-info",
    async (
      _event,
      roomIdentifier: string,
      messageId: string,
    ): Promise<import("../../ipc-types.js").DesktopMessageInfo | null> =>
      getDesktopRoomMessageInfo(roomIdentifier, messageId),
  );
  targetIpcMain.handle(
    "desktop:room:get-message",
    async (
      _event,
      roomIdentifier: string,
      messageId: string,
    ): Promise<DesktopRoomMessage | null> =>
      getDesktopRoomMessage(roomIdentifier, messageId),
  );
  targetIpcMain.handle(
    "desktop:room:get-messages-before",
    async (
      _event,
      roomIdentifier: string,
      beforeMessageId: string,
      limit?: number,
    ): Promise<DesktopRoomMessagesPage> =>
      getDesktopRoomMessagesBefore(roomIdentifier, beforeMessageId, limit),
  );
  targetIpcMain.handle(
    "desktop:room:get-threads",
    async (
      _event,
      roomIdentifier: string,
      filter?: DesktopRoomThreadInboxFilter,
      beforeMessageId?: string | null,
      limit?: number,
    ): Promise<DesktopRoomThreadInboxPage> =>
      getDesktopRoomThreads(roomIdentifier, filter, beforeMessageId, limit),
  );
  targetIpcMain.handle(
    "desktop:room:get-thread",
    async (
      _event,
      roomIdentifier: string,
      threadRootId: string,
      beforeMessageId?: string | null,
      limit?: number,
    ): Promise<DesktopRoomThreadPage> =>
      getDesktopRoomThread(roomIdentifier, threadRootId, beforeMessageId, limit),
  );
  targetIpcMain.handle(
    "desktop:room:mark-thread-read",
    async (
      _event,
      roomIdentifier: string,
      threadRootId: string,
      messageId?: string | null,
    ): Promise<DesktopRoomThreadReadResult> =>
      markDesktopRoomThreadRead(roomIdentifier, threadRootId, messageId),
  );
  targetIpcMain.handle(
    "desktop:room:get-reasoning-session",
    async (
      _event,
      roomIdentifier: string,
      sessionId: string,
    ): Promise<DesktopReasoningSessionDetail> =>
      getDesktopReasoningSession(roomIdentifier, sessionId),
  );
  targetIpcMain.handle(
    "desktop:room:pick-attachments",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopStagedAttachment[]> =>
      pickAndStageDesktopAttachments(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:room:stage-dropped-attachment-contents",
    async (
      _event,
      roomIdentifier: string,
      files: DesktopDroppedAttachmentContent[],
    ): Promise<DesktopStagedAttachment[]> =>
      stageDroppedDesktopAttachmentContents(roomIdentifier, files),
  );
  targetIpcMain.handle(
    "desktop:room:discard-attachment",
    async (_event, roomIdentifier: string, uploadId: string): Promise<void> =>
      discardDesktopAttachment(roomIdentifier, uploadId),
  );
  targetIpcMain.handle(
    "desktop:room:start-stream",
    async (
      _event,
      roomIdentifier: string,
      afterMessageId?: string | null,
    ): Promise<void> => startDesktopRoomStream(roomIdentifier, afterMessageId),
  );
  targetIpcMain.handle(
    "desktop:room:repair-stream-delivery",
    async (
      _event,
      roomIdentifier: string,
      repair: DesktopRoomDeliveryRepair,
    ): Promise<void> => repairDesktopRoomStreamManagedDelivery(roomIdentifier, repair),
  );
  targetIpcMain.handle(
    "desktop:room:stop-stream",
    async (_event, roomIdentifier?: string | null): Promise<void> =>
      stopDesktopRoomStream(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:room:send-message",
    async (
      _event,
      roomIdentifier: string,
      text: string,
      replyTo?: string | null,
      attachments?: Array<{ upload_id: string }>,
      threadRootId?: string | null,
    ): Promise<DesktopSendRoomMessageResult> => {
      const send = await sendDesktopRoomMessage(
        roomIdentifier,
        text,
        replyTo,
        attachments ?? [],
        threadRootId,
      );
      if (send.managedDelivery === "direct_cloud") {
        await deliverDesktopRoomMessageToManagedAgents(
          roomIdentifier,
          send.result.message,
        );
      }
      const result = send.result;
      return result;
    },
  );
  targetIpcMain.handle(
    "desktop:room:add-task",
    async (
      _event,
      roomIdentifier: string,
      input: DesktopTaskCreateInput,
    ): Promise<DesktopTaskMutationResult> =>
      addDesktopRoomTask(roomIdentifier, input),
  );
  targetIpcMain.handle(
    "desktop:room:update-task",
    async (
      _event,
      roomIdentifier: string,
      taskId: string,
      updates: {
        status?: string;
        assignee?: string | null;
        pr_url?: string | null;
      },
    ): Promise<DesktopTaskMutationResult> =>
      updateDesktopRoomTask(roomIdentifier, taskId, updates),
  );
  targetIpcMain.handle(
    "desktop:room:update-task-lease",
    async (
      _event,
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskLeaseActionInput,
    ): Promise<DesktopTaskMutationResult> =>
      updateDesktopRoomTaskLease(roomIdentifier, taskId, input),
  );
  targetIpcMain.handle(
    "desktop:room:update-task-review-lease",
    async (
      _event,
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskReviewLeaseActionInput,
    ): Promise<DesktopTaskMutationResult> =>
      updateDesktopRoomTaskReviewLease(roomIdentifier, taskId, input),
  );
  targetIpcMain.handle(
    "desktop:room:run-task-worker-action",
    async (
      _event,
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskWorkerActionInput,
    ): Promise<DesktopTaskMutationResult> =>
      runDesktopRoomTaskWorkerAction(roomIdentifier, taskId, input),
  );
  targetIpcMain.handle(
    "desktop:room:run-task-review-worker-action",
    async (
      _event,
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskReviewWorkerActionInput,
    ): Promise<DesktopTaskMutationResult> =>
      runDesktopRoomTaskReviewWorkerAction(roomIdentifier, taskId, input),
  );
  targetIpcMain.handle(
    "desktop:room:get-board-governance",
    async (_event, roomIdentifier: string) => isDesktopSmokeCheck()
      ? desktopSmokeBoardGovernance()
      : getDesktopBoardGovernance(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:room:assign-board-manager",
    async (_event, roomIdentifier: string, input: DesktopBoardGovernanceAssignManagerInput) =>
      assignDesktopBoardManager(roomIdentifier, input),
  );
  targetIpcMain.handle(
    "desktop:room:release-board-manager",
    async (_event, roomIdentifier: string, input?: DesktopBoardGovernanceReleaseManagerInput) =>
      releaseDesktopBoardManager(roomIdentifier, input ?? {}),
  );
  targetIpcMain.handle(
    "desktop:room:set-board-manager-mode",
    async (_event, roomIdentifier: string, input: DesktopBoardGovernanceSetModeInput) =>
      setDesktopBoardManagerMode(roomIdentifier, input),
  );
  targetIpcMain.handle(
    "desktop:room:decide-board-intent",
    async (
      _event,
      roomIdentifier: string,
      intentId: string,
      input: DesktopBoardIntentDecisionInput,
    ) => decideDesktopBoardIntent(roomIdentifier, intentId, input),
  );
  targetIpcMain.handle(
    "desktop:room:create-task-focus-room",
    async (
      _event,
      roomIdentifier: string,
      taskId: string,
    ): Promise<DesktopFocusRoomMutationResult> =>
      createDesktopTaskFocusRoom(roomIdentifier, taskId),
  );
  targetIpcMain.handle(
    "desktop:room:create-ad-hoc-focus-room",
    async (
      _event,
      roomIdentifier: string,
      title: string,
    ): Promise<DesktopFocusRoomMutationResult> =>
      createDesktopAdHocFocusRoom(roomIdentifier, title),
  );
  targetIpcMain.handle(
    "desktop:room:update-focus-room-settings",
    async (
      _event,
      roomIdentifier: string,
      focusKey: string,
      settings: DesktopFocusRoomSettingsPatch,
    ): Promise<DesktopFocusRoomMutationResult> =>
      updateDesktopFocusRoomSettings(roomIdentifier, focusKey, settings),
  );
  targetIpcMain.handle(
    "desktop:room:conclude-focus-room",
    async (
      _event,
      roomIdentifier: string,
      focusKey: string,
      summary: string,
      details: DesktopFocusRoomConclusionDetails | null,
      quickClose: boolean,
    ): Promise<DesktopFocusRoomMutationResult> =>
      concludeDesktopFocusRoom(roomIdentifier, focusKey, summary, details, quickClose),
  );
  targetIpcMain.handle(
    "desktop:room:archive-focus-room",
    async (
      _event,
      roomIdentifier: string,
      focusKey: string,
    ): Promise<DesktopFocusRoomMutationResult> =>
      archiveDesktopFocusRoom(roomIdentifier, focusKey),
  );
  targetIpcMain.handle(
    "desktop:room:rename",
    async (
      _event,
      roomIdentifier: string,
      displayName: string,
    ): Promise<DesktopRoomInfo> =>
      renameDesktopRoom(roomIdentifier, displayName),
  );
  targetIpcMain.handle(
    "desktop:room:create-invite-room",
    async (): Promise<DesktopInviteRoomCreation> => createDesktopInviteRoom(),
  );
  targetIpcMain.handle(
    "desktop:room:get-github-events",
    async (
      _event,
      roomIdentifier: string,
      query?: DesktopGitHubEventsQuery,
    ): Promise<DesktopGitHubEventsPage> =>
      getDesktopGitHubEvents(roomIdentifier, query),
  );
  targetIpcMain.handle(
    "desktop:room:get-artifacts",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopRoomSharedArtifact[]> =>
      getDesktopRoomArtifacts(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:room:get-github-integration-status",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopGitHubIntegrationStatus> =>
      getDesktopGitHubIntegrationStatus(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:room:open-github-install",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopGitHubIntegrationActionResult> =>
      openDesktopGitHubInstall(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:chat-storage:get-settings",
    async (): Promise<DesktopChatStorageSettings> => readChatStorageSettings(),
  );
  targetIpcMain.handle(
    "desktop:chat-storage:set-mode",
    async (
      _event,
      mode: DesktopChatStorageSettings["mode"],
    ): Promise<DesktopChatStorageSettings> => setChatStorageMode(mode),
  );
  targetIpcMain.handle(
    "desktop:chat-storage:get-room-storage",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopRoomStorageState> =>
      getDesktopRoomStorage(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:chat-storage:set-room-mode",
    async (
      _event,
      roomIdentifier: string,
      mode: DesktopRoomStorageOverrideMode,
    ): Promise<DesktopRoomStorageState> =>
      setDesktopRoomStorageMode(roomIdentifier, mode),
  );
  targetIpcMain.handle(
    "desktop:chat-storage:create-local-room",
    async (
      _event,
      input?: { displayName?: string | null },
    ): Promise<DesktopLocalRoomMutationResult> =>
      createDesktopLocalRoom(input ?? {}),
  );
  targetIpcMain.handle(
    "desktop:chat-storage:fork-room-to-local",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopLocalRoomMutationResult> =>
      forkDesktopRoomToLocal(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:chat-storage:publish-local-room",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopLocalChatSyncResult> =>
      publishDesktopLocalRoom(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:chat-storage:sync-local-room",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopLocalChatSyncResult> =>
      syncDesktopLocalChatRoom(roomIdentifier),
  );
}
