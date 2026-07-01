import { ipcMain } from "electron";
import type { IpcMain } from "electron";

import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopAgentProviderSetupInput,
  DesktopAgentProviderSetupResult,
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
  DesktopAppAgentSaveSettingsInput,
  DesktopAppAgentSettingsStatus,
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentPermissionDecisionInput,
  DesktopManagedAgentPermissionDecisionResult,
  DesktopOpenModelSaveSettingsInput,
  DesktopOpenModelSettingsStatus,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
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
  DesktopLocalRoomMutationResult,
  DiagnosticsSnapshot,
  DesktopFocusRoomInfo,
  DesktopGitHubEventsPage,
  DesktopGitHubEventsQuery,
  DesktopGitHubIntegrationActionResult,
  DesktopGitHubIntegrationStatus,
  DesktopInviteRoomCreation,
  DesktopLocalChatSyncResult,
  DesktopRoomStorageOverrideMode,
  DesktopRoomStorageState,
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
  DesktopRoomThreadInboxFilter,
  DesktopRoomThreadInboxPage,
  DesktopRoomThreadPage,
  DesktopRoomThreadReadResult,
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
  setAuthInvalidatedHandler,
  startDeviceAuthFlow,
} from "./auth.js";
import {
  buildMcpInstallState,
  completeMcpOnboarding,
  installLetAgentsMcpServer,
  installLetAgentsMcpServers,
  refreshInstalledLetAgentsMcpServerAuth,
} from "./mcp-setup.js";
import {
  listDesktopAgentProviders,
  runDesktopAgentProviderPreflight,
  runDesktopAgentProviderSetup,
} from "./agents/providers.js";
import {
  inspectDesktopManagedAgentSession,
  listDesktopManagedAgentSessions,
  resolveDesktopManagedAgentPermissionRequest,
  startDesktopManagedAgent,
  stopDesktopManagedAgent,
} from "./agents/codex-supervisor.js";
import {
  buildDiagnosticsSnapshot,
  buildWorkerSnapshots,
  clearJoinedRoomInfoCache,
  createDesktopInviteRoom,
  deleteDesktopAccountRoom,
  fetchRoomSnapshot,
  getDesktopGitHubEvents,
  getDesktopGitHubIntegrationStatus,
  getDesktopRoomLatestMessages,
  getDesktopRoomStorage,
  getDesktopRoomThread,
  getDesktopRoomThreads,
  getDesktopReasoningSession,
  getDesktopRoomMessagesBefore,
  leaveDesktopAccountRoom,
  listDesktopAccountRooms,
  openDesktopGitHubInstall,
  openRepoRoomFromPath,
  pickRepoRoom,
  markDesktopRoomThreadRead,
  renameDesktopRoom,
  runDesktopRoomTaskReviewWorkerAction,
  runDesktopRoomTaskWorkerAction,
  sendDesktopRoomMessage,
  readChatStorageSettings,
  addDesktopRoomTask,
  archiveDesktopFocusRoom,
  concludeDesktopFocusRoom,
  createDesktopAdHocFocusRoom,
  createDesktopTaskFocusRoom,
  createDesktopLocalRoom,
  forkDesktopRoomToLocal,
  publishDesktopLocalRoom,
  setChatStorageMode,
  setDesktopRoomStorageMode,
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
  deliverDesktopRoomMessageToManagedAgents,
  emitRoomStreamEvent,
  getActiveRoomIdentifier,
  startDesktopRoomStream,
  stopDesktopRoomStream,
} from "./room-stream.js";
import { apiUrl, workspaceRoot } from "./paths.js";
import { openAllowedExternalUrl } from "./external-url.js";
import {
  getAppAgentSettingsStatus,
  saveAppAgentSettings,
} from "./app-agent/settings.js";
import {
  listDesktopAppAgentActions,
  runDesktopAppAgent,
} from "./app-agent/runner.js";
import {
  getOpenModelSettingsStatus,
  saveOpenModelSettings,
} from "./agents/open-model-settings.js";

export function registerDesktopIpcHandlers(
  targetIpcMain: IpcMain = ipcMain,
): void {
  setAuthAuthorizedHandler(() => {
    clearJoinedRoomInfoCache();
    void refreshInstalledLetAgentsMcpServerAuth().catch(() => {});
  });
  setAuthInvalidatedHandler(() => {
    clearJoinedRoomInfoCache();
    void refreshInstalledLetAgentsMcpServerAuth().catch(() => {});
  });
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
    "desktop:app-agent:get-settings-status",
    async (): Promise<DesktopAppAgentSettingsStatus> =>
      getAppAgentSettingsStatus(),
  );
  targetIpcMain.handle(
    "desktop:app-agent:save-settings",
    async (
      _event,
      input: DesktopAppAgentSaveSettingsInput,
    ): Promise<DesktopAppAgentSettingsStatus> => saveAppAgentSettings(input),
  );
  targetIpcMain.handle(
    "desktop:app-agent:list-actions",
    async () => listDesktopAppAgentActions(),
  );
  targetIpcMain.handle(
    "desktop:app-agent:run",
    async (
      _event,
      input: DesktopAppAgentRunInput,
    ): Promise<DesktopAppAgentRunResult> => runDesktopAppAgent(input),
  );
  targetIpcMain.handle(
    "desktop:open-model:get-settings-status",
    async (): Promise<DesktopOpenModelSettingsStatus> =>
      getOpenModelSettingsStatus(),
  );
  targetIpcMain.handle(
    "desktop:open-model:save-settings",
    async (
      _event,
      input: DesktopOpenModelSaveSettingsInput,
    ): Promise<DesktopOpenModelSettingsStatus> => saveOpenModelSettings(input),
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
      const result = await sendDesktopRoomMessage(roomIdentifier, text, replyTo, attachments ?? [], threadRootId);
      deliverDesktopRoomMessageToManagedAgents(roomIdentifier, result.message);
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
      await refreshInstalledLetAgentsMcpServerAuth().catch(() => {});
      return getDesktopAuthStatus();
    },
  );
  targetIpcMain.handle(
    "desktop:setup:get-mcp-install-state",
    async (): Promise<DesktopMcpInstallState> => buildMcpInstallState(),
  );
  targetIpcMain.handle(
    "desktop:setup:install-mcp-server",
    async (
      _event,
      targetId: DesktopMcpInstallTargetId,
    ): Promise<DesktopMcpInstallResult> =>
      installLetAgentsMcpServer(targetId),
  );
  targetIpcMain.handle(
    "desktop:setup:install-mcp-servers",
    async (
      _event,
      targetIds: DesktopMcpInstallTargetId[],
    ): Promise<DesktopMcpInstallManyResult> =>
      installLetAgentsMcpServers(targetIds),
  );
  targetIpcMain.handle(
    "desktop:setup:complete-mcp-onboarding",
    async (): Promise<DesktopMcpInstallState> => completeMcpOnboarding(),
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
    "desktop:repos:open-room",
    async (_event, folderPath?: string | null): Promise<DesktopRepoRoomSelection> =>
      openRepoRoomFromPath(folderPath || ""),
  );
  targetIpcMain.handle(
    "desktop:workers:list",
    async (): Promise<WorkerSnapshot[]> => buildWorkerSnapshots(),
  );
  targetIpcMain.handle(
    "desktop:workers:list-managed-agent-sessions",
    async (
      _event,
      roomIdentifier?: string | null,
    ): Promise<DesktopManagedAgentSession[]> =>
      listDesktopManagedAgentSessions(roomIdentifier ?? null),
  );
  targetIpcMain.handle(
    "desktop:workers:start-managed-agent",
    async (
      _event,
      input: DesktopManagedAgentStartInput,
    ): Promise<DesktopManagedAgentStartResult> => startDesktopManagedAgent(input),
  );
  targetIpcMain.handle(
    "desktop:workers:stop-managed-agent",
    async (
      _event,
      input?: DesktopManagedAgentStopInput,
    ): Promise<DesktopManagedAgentSession | null> =>
      stopDesktopManagedAgent(input ?? {}),
  );
  targetIpcMain.handle(
    "desktop:workers:inspect-managed-agent",
    async (
      _event,
      sessionId?: string | null,
      roomIdentifier?: string | null,
    ): Promise<DesktopManagedAgentInspectResult | null> =>
      inspectDesktopManagedAgentSession(sessionId ?? null, roomIdentifier ?? null),
  );
  targetIpcMain.handle(
    "desktop:workers:resolve-managed-agent-permission",
    async (
      _event,
      input: DesktopManagedAgentPermissionDecisionInput,
    ): Promise<DesktopManagedAgentPermissionDecisionResult> =>
      resolveDesktopManagedAgentPermissionRequest(input),
  );
  targetIpcMain.handle(
    "desktop:workers:list-agent-providers",
    async (): Promise<DesktopAgentProvider[]> => listDesktopAgentProviders(),
  );
  targetIpcMain.handle(
    "desktop:workers:run-agent-provider-preflight",
    async (
      _event,
      providerId: DesktopAgentProviderId,
      input?: DesktopAgentProviderPreflightInput,
    ): Promise<DesktopAgentProviderPreflight> =>
      runDesktopAgentProviderPreflight(providerId, input ?? {}),
  );
  targetIpcMain.handle(
    "desktop:workers:run-agent-provider-setup",
    async (
      _event,
      providerId: DesktopAgentProviderId,
      input: DesktopAgentProviderSetupInput,
    ): Promise<DesktopAgentProviderSetupResult> =>
      runDesktopAgentProviderSetup(providerId, input),
  );
  targetIpcMain.handle(
    "desktop:diagnostics:get-snapshot",
    async (): Promise<DiagnosticsSnapshot> => buildDiagnosticsSnapshot(),
  );
}
