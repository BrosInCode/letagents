import { ipcMain } from "electron";
import type { IpcMain } from "electron";

import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopAccountFocusRoomEntry,
  DesktopAccountRoomActionResult,
  DesktopAccountRoomEntry,
  DesktopAccountRoomListOptions,
  DesktopAuthAccount,
  DesktopAuthPollResult,
  DesktopAuthStartResult,
  DesktopAuthStatus,
  DesktopAppInfo,
  DesktopChatStorageSettings,
  DiagnosticsSnapshot,
  DesktopFocusRoomInfo,
  DesktopGitHubIntegrationActionResult,
  DesktopGitHubIntegrationStatus,
  DesktopInviteRoomCreation,
  DesktopLocalChatSyncResult,
  DesktopMcpInstallManyResult,
  DesktopMcpInstallResult,
  DesktopMcpInstallState,
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
  DesktopPendingDeviceAuth,
  DesktopReasoningSession,
  DesktopReasoningSessionDetail,
  DesktopReasoningUpdate,
  DesktopRoomAccess,
  DesktopRoomLatestMessage,
  DesktopRoomMessage,
  DesktopRepoRoomSelection,
  DesktopSendRoomMessageResult,
  DesktopParticipantSummary,
  DesktopDroppedAttachmentContent,
  DesktopFocusRoomConclusionDetails,
  DesktopFocusRoomMutationResult,
  DesktopFocusRoomSettingsPatch,
  DesktopRoomInfo,
  DesktopRoomMessagesPage,
  DesktopRoomSnapshot,
  DesktopRoomStreamEvent,
  DesktopStagedAttachment,
  DesktopTaskCreateInput,
  DesktopTaskLeaseActionInput,
  DesktopTaskMutationResult,
  DesktopTaskReviewLeaseActionInput,
  DesktopTaskReviewWorkerActionInput,
  DesktopTaskWorkerActionInput,
  DesktopTaskSummary,
  RepoStatus,
  WorkerSnapshot,
} from "../ipc-types.js";
import { buildRepoStatus } from "../repo-status.js";
import { registerDesktopRentalIpcHandlers } from "../rental-handlers.js";
import { RentalApiClient } from "../rental/api-client.js";
import { RenterTriggerRuntime } from "../rental/renter-trigger.js";
import {
  clearStoredAuth,
  getDesktopAuthStatus,
  pollDeviceAuthFlow,
  readStoredAuth,
  setAuthAuthorizedHandler,
  startDeviceAuthFlow,
} from "./auth.js";
import {
  buildMcpInstallState,
  completeMcpOnboarding,
  installLetAgentsMcpServer,
  installLetAgentsMcpServers,
} from "./mcp-setup.js";
import {
  buildDiagnosticsSnapshot,
  buildWorkerSnapshots,
  clearJoinedRoomInfoCache,
  createDesktopInviteRoom,
  deleteDesktopAccountRoom,
  fetchRoomSnapshot,
  getDesktopGitHubIntegrationStatus,
  getDesktopRoomLatestMessages,
  getDesktopReasoningSession,
  getDesktopRoomMessagesBefore,
  leaveDesktopAccountRoom,
  listDesktopAccountRooms,
  openDesktopGitHubInstall,
  pickRepoRoom,
  renameDesktopRoom,
  runDesktopRoomTaskReviewWorkerAction,
  runDesktopRoomTaskWorkerAction,
  sendDesktopRoomMessage,
  readChatStorageSettings,
  addDesktopRoomTask,
  concludeDesktopFocusRoom,
  createDesktopAdHocFocusRoom,
  createDesktopTaskFocusRoom,
  setChatStorageMode,
  syncDesktopLocalChatRoom,
  updateDesktopAccountRoom,
  updateDesktopFocusRoomSettings,
  updateDesktopRoomTask,
  updateDesktopRoomTaskLease,
  updateDesktopRoomTaskReviewLease,
} from "./rooms.js";
import {
  discardDesktopAttachment,
  pickAndStageDesktopAttachments,
  stageDroppedDesktopAttachmentContents,
} from "./attachments.js";
import {
  emitRoomStreamEvent,
  getActiveRoomIdentifier,
  startDesktopRoomStream,
  stopDesktopRoomStream,
} from "./room-stream.js";
import { apiUrl, workspaceRoot } from "./paths.js";
import { openAllowedExternalUrl } from "./external-url.js";

export function registerDesktopIpcHandlers(
  targetIpcMain: IpcMain = ipcMain,
): void {
  setAuthAuthorizedHandler(clearJoinedRoomInfoCache);
  const renterTriggerRuntime = new RenterTriggerRuntime({
    getRoomIdentifier: getActiveRoomIdentifier,
    emitRoomStreamEvent,
  });

  targetIpcMain.handle(
    "desktop:app:get-info",
    async (): Promise<DesktopAppInfo> => ({
      appName: "LetAgents Desktop",
      platform: process.platform,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      workspaceRoot,
      apiUrl,
    }),
  );

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
    "desktop:room:get-latest-messages",
    async (
      _event,
      roomIdentifiers: string[],
    ): Promise<DesktopRoomLatestMessage[]> =>
      getDesktopRoomLatestMessages(Array.isArray(roomIdentifiers) ? roomIdentifiers : []),
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
    ): Promise<DesktopSendRoomMessageResult> =>
      sendDesktopRoomMessage(roomIdentifier, text, replyTo, attachments ?? []),
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
    ): Promise<DesktopFocusRoomMutationResult> =>
      concludeDesktopFocusRoom(roomIdentifier, focusKey, summary, details),
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
    "desktop:chat-storage:sync-local-room",
    async (
      _event,
      roomIdentifier: string,
    ): Promise<DesktopLocalChatSyncResult> =>
      syncDesktopLocalChatRoom(roomIdentifier),
  );
  // Build the rental API client once at startup. The auth token is
  // resolved on every request via `readStoredAuth()` so sign-in /
  // sign-out cycles take effect without rebuilding the client.
  // The IPC handlers in `rental-handlers.ts` fall back to their
  // pre-p1.8c stubs when an API call fails, so a network outage or
  // missing auth never blocks the desktop UI from rendering.
  const rentalApiClient = new RentalApiClient({
    apiBaseUrl: apiUrl,
    async getAuthToken() {
      try {
        const stored = await readStoredAuth();
        return stored.token ?? null;
      } catch {
        return null;
      }
    },
  });
  registerDesktopRentalIpcHandlers(targetIpcMain, {
    renterTriggerRuntime,
    apiClient: rentalApiClient,
  });
  targetIpcMain.handle(
    "desktop:auth:get-status",
    async (): Promise<DesktopAuthStatus> => getDesktopAuthStatus(),
  );
  targetIpcMain.handle(
    "desktop:auth:start-device-flow",
    async (
      _event,
      roomIdentifier?: string | null,
    ): Promise<DesktopAuthStartResult> => startDeviceAuthFlow(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:auth:poll-device-flow",
    async (_event, requestId?: string | null): Promise<DesktopAuthPollResult> =>
      pollDeviceAuthFlow(requestId),
  );
  targetIpcMain.handle(
    "desktop:auth:open-verification",
    async (_event, url: string): Promise<void> => {
      await openAllowedExternalUrl(url, ["github.com"]);
    },
  );
  targetIpcMain.handle(
    "desktop:auth:sign-out",
    async (): Promise<DesktopAuthStatus> => {
      clearJoinedRoomInfoCache();
      await clearStoredAuth();
      return getDesktopAuthStatus();
    },
  );
  targetIpcMain.handle(
    "desktop:setup:get-mcp-install-state",
    async (): Promise<DesktopMcpInstallState> => {
      return buildMcpInstallState();
    },
  );
  targetIpcMain.handle(
    "desktop:setup:install-mcp-server",
    async (
      _event,
      targetId: DesktopMcpInstallTargetId,
    ): Promise<DesktopMcpInstallResult> => {
      return installLetAgentsMcpServer(targetId);
    },
  );
  targetIpcMain.handle(
    "desktop:setup:install-mcp-servers",
    async (
      _event,
      targetIds: DesktopMcpInstallTargetId[],
    ): Promise<DesktopMcpInstallManyResult> => {
      return installLetAgentsMcpServers(targetIds);
    },
  );
  targetIpcMain.handle(
    "desktop:setup:complete-mcp-onboarding",
    async (): Promise<DesktopMcpInstallState> => {
      return completeMcpOnboarding();
    },
  );
  targetIpcMain.handle(
    "desktop:repos:get-status",
    async (_event, rootPath?: string | null): Promise<RepoStatus> => buildRepoStatus(rootPath || workspaceRoot),
  );
  targetIpcMain.handle(
    "desktop:repos:pick-room",
    async (): Promise<DesktopRepoRoomSelection> => pickRepoRoom(),
  );
  targetIpcMain.handle(
    "desktop:workers:list",
    async (): Promise<WorkerSnapshot[]> => buildWorkerSnapshots(),
  );
  targetIpcMain.handle(
    "desktop:diagnostics:get-snapshot",
    async (): Promise<DiagnosticsSnapshot> => buildDiagnosticsSnapshot(),
  );
}
