import { createDesktopMessageReminder, getDesktopMessageReminders, deleteDesktopMessageReminder } from "../rooms/reminders.js";
import { getDesktopConversationRouting, setDesktopConversationRouting } from "../rooms/conversation-routing.js";
import { getDesktopMessageLinkPreviews } from "../rooms/link-previews.js";
import { getDesktopMessagePins, setDesktopMessagePin } from "../rooms/pins.js";
import { reportDesktopRoomTyping } from "../rooms/typing.js";
import { getDesktopPullRequestDiff } from "../rooms/pull-request-diff.js";
import { getDesktopMessageReactions, setDesktopMessageReaction } from "../rooms/reactions.js";
import { searchDesktopRoomMessages } from "../rooms/search.js";
import { getAccountActivityState, restartAccountActivityStream, stopAccountActivityStream } from "../account-activity-stream.js";
import { getDesktopGitHubEventFilter, getDesktopRoomAgentGuidelines, setDesktopGitHubEventFilter, setDesktopRoomAgentGuidelines } from "../rooms/room-settings.js";
import { getDesktopRoomNotificationPreference, listDesktopRoomNotificationPreferences, setDesktopRoomNotificationPreference } from "../rooms/notification-preferences.js";
import type { RoomNotificationPreferenceChange } from "../../../../../shared/room-notification-preferences.mjs";
import { cancelDesktopRoomWakeRule, getDesktopRoomWakeRules, restoreDesktopRoomWakeRule } from "../rooms/wake-rules.js";
import { getDesktopNeedsYou, getDesktopNeedsYouRoom, getDesktopKnowledge, createDesktopKnowledge, reviseDesktopKnowledge, getDesktopMemoryHistory } from "../rooms/knowledge.js";
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
  DesktopRoomAgentWorkPollResult,
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
  pollDesktopRoomAgentWork,
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
import { liveSupervisorStateEntries } from "../supervisor-daemon.js";

export function registerDesktopRoomIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle("desktop:room:needs-you", async (_event, includeUpdates) => {
    const needsYou = await getDesktopNeedsYou(includeUpdates === true);
    const agents = liveSupervisorStateEntries();
    return agents ? { ...needsYou, agents } : needsYou;
  });
  targetIpcMain.handle("desktop:room:needs-you-room", (_event, room, includeBoardIntents) =>
    getDesktopNeedsYouRoom(room, includeBoardIntents === true));
  targetIpcMain.handle("desktop:room:knowledge", (_event, room, type) => getDesktopKnowledge(room, type));
  targetIpcMain.handle("desktop:room:knowledge-create", (_event, room, type, input) => createDesktopKnowledge(room, type, input));
  targetIpcMain.handle("desktop:room:knowledge-revise", (_event, room, type, id, input) => reviseDesktopKnowledge(room, type, id, input));
  targetIpcMain.handle("desktop:room:memory-history", (_event, room, id) => getDesktopMemoryHistory(room, id));
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
    "desktop:room:poll-agent-work",
    async (
      _event,
      roomIdentifier: string,
      afterCursor?: string | null,
    ): Promise<DesktopRoomAgentWorkPollResult> =>
      pollDesktopRoomAgentWork(roomIdentifier, afterCursor),
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
      clientMessageId?: string | null,
      messageNamespace?: string | null,
    ): Promise<DesktopSendRoomMessageResult> => {
      const result = await sendDesktopRoomMessage(roomIdentifier, text, replyTo, attachments ?? [], threadRootId, clientMessageId, messageNamespace);
      // Local dispatch is secondary to the saved message acknowledgement.
      // Keep its routing/retry path running without making the user resend.
      void Promise.resolve().then(() =>
        deliverDesktopRoomMessageToManagedAgents(roomIdentifier, result.message),
      ).catch((error) => {
        console.error(`[room messages] failed managed delivery for ${roomIdentifier}/${result.message.id}`, error);
      });
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
        title?: string;
        description?: string;
        expected_content?: { title?: string; description?: string };
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
  targetIpcMain.handle("desktop:room:get-conversation-routing", (_event, roomIdentifier: string) => getDesktopConversationRouting(roomIdentifier));
  targetIpcMain.handle("desktop:room:set-conversation-routing", (_event, roomIdentifier: string, enabled: boolean) => setDesktopConversationRouting(roomIdentifier, enabled));
  targetIpcMain.handle("desktop:room:get-message-link-previews", (_event, roomIdentifier: string, references) => getDesktopMessageLinkPreviews(roomIdentifier, references));
  targetIpcMain.handle("desktop:room:get-message-pins", (_event, roomIdentifier: string) => getDesktopMessagePins(roomIdentifier));
  targetIpcMain.handle("desktop:room:create-message-reminder", (_event, room: string, message: string, dueAt: string) => createDesktopMessageReminder(room, message, dueAt));
  targetIpcMain.handle("desktop:room:get-message-reminders", (_event, offset?: number) => getDesktopMessageReminders(offset));
  targetIpcMain.handle("desktop:room:delete-message-reminder", (_event, id: string) => deleteDesktopMessageReminder(id));
  targetIpcMain.handle("desktop:room:set-message-pin", (_event, roomIdentifier: string, messageId: string, pinned: boolean) => setDesktopMessagePin(roomIdentifier, messageId, pinned));
  targetIpcMain.handle("desktop:room:report-typing", (_event, room: string, input: unknown) => reportDesktopRoomTyping(room, input));
  targetIpcMain.handle("desktop:room:get-message-reactions", (_event, roomIdentifier: string, firstMessageId: string, lastMessageId: string) =>
    getDesktopMessageReactions(roomIdentifier, firstMessageId, lastMessageId));
  targetIpcMain.handle("desktop:room:set-message-reaction", (_event, roomIdentifier: string, messageId: string, emoji: string, reacted: boolean) =>
    setDesktopMessageReaction(roomIdentifier, messageId, emoji, reacted));
  targetIpcMain.handle("desktop:room:search-messages", (_event, roomIdentifier: string, query: string, beforeMessageId?: string | null) =>
    searchDesktopRoomMessages(roomIdentifier, query, beforeMessageId));
  targetIpcMain.handle("desktop:room:get-account-activity", () => getAccountActivityState());
  targetIpcMain.handle("desktop:room:restart-account-activity", () => restartAccountActivityStream());
  targetIpcMain.handle("desktop:room:stop-account-activity", () => stopAccountActivityStream());
  targetIpcMain.handle("desktop:room:get-github-event-filter", (_event, roomIdentifier: string) => getDesktopGitHubEventFilter(roomIdentifier));
  targetIpcMain.handle("desktop:room:set-github-event-filter", (_event, roomIdentifier: string, enabledKinds: unknown) => setDesktopGitHubEventFilter(roomIdentifier, enabledKinds));
  targetIpcMain.handle("desktop:room:get-agent-guidelines", (_event, roomIdentifier: string) => getDesktopRoomAgentGuidelines(roomIdentifier));
  targetIpcMain.handle("desktop:room:list-notification-preferences", () => listDesktopRoomNotificationPreferences());
  targetIpcMain.handle("desktop:room:get-notification-preference", (_event, identifier: string) => getDesktopRoomNotificationPreference(identifier));
  targetIpcMain.handle("desktop:room:set-notification-preference", (_event, identifier: string, change: RoomNotificationPreferenceChange) => setDesktopRoomNotificationPreference(identifier, change));
  targetIpcMain.handle("desktop:room:set-agent-guidelines", (_event, roomIdentifier: string, guidelines: unknown) => setDesktopRoomAgentGuidelines(roomIdentifier, guidelines));
  targetIpcMain.handle("desktop:room:get-wake-rules", (_event, roomIdentifier: string) => getDesktopRoomWakeRules(roomIdentifier));
  targetIpcMain.handle("desktop:room:cancel-wake-rule", (_event, roomIdentifier: string, ruleId: string) => cancelDesktopRoomWakeRule(roomIdentifier, ruleId));
  targetIpcMain.handle("desktop:room:restore-wake-rule", (_event, roomIdentifier: string, ruleId: string) => restoreDesktopRoomWakeRule(roomIdentifier, ruleId));
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
    "desktop:room:get-pull-request-diff",
    (_event, roomIdentifier: string, number: number) => getDesktopPullRequestDiff(roomIdentifier, number),
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
