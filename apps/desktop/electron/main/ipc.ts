import electron from "electron";
import type { IpcMain } from "electron";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { redactCredentialText } from "./agents/provider-evidence.js";

import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopAgentProviderSetupInput,
  DesktopAgentProviderSetupResult,
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
  DesktopAppAgentSaveSettingsInput,
  DesktopAppAgentSettingsStatus,
  DesktopManagedAgentChangeSummary,
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentPermissionDecisionInput,
  DesktopManagedAgentPermissionDecisionResult,
  DesktopManagedAgentRetryInput,
  DesktopOpenModelSaveSettingsInput,
  DesktopOpenModelSettingsStatus,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
  DesktopSupervisorAttemptDetail,
  DesktopSupervisorCreateInput,
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorDesiredState,
  DesktopSupervisorManifestEntry,
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
  DesktopRoomSharedArtifact,
  DesktopLocalChatSyncResult,
  DesktopRoomStorageOverrideMode,
  DesktopRoomStorageState,
  DesktopMcpInstallManyResult,
  DesktopMcpInstallResult,
  DesktopMcpInstallState,
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
  DesktopPendingDeviceAuth,
  DesktopProvisionSupervisorGrantInput,
  DesktopReasoningSession,
  DesktopReasoningSessionDetail,
  DesktopReasoningUpdate,
  DesktopRoomAccess,
  DesktopRoomLatestMessage,
  DesktopRoomMessage,
  DesktopRepoRoomSelection,
  DesktopRepoWorktreeResult,
  DesktopSendRoomMessageResult,
  DesktopParticipantSummary,
  DesktopDroppedAttachmentContent,
  DesktopFocusRoomConclusionDetails,
  DesktopFocusRoomMutationResult,
  DesktopFocusRoomSettingsPatch,
  DesktopRoomInfo,
  DesktopRoomLiveMetadata,
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
  DesktopSupervisorGrantMetadata,
  RepoStatus,
  WorkerSnapshot,
} from "../ipc-types.js";
import type {
  DesktopBoardGovernanceAssignManagerInput,
  DesktopBoardGovernanceReleaseManagerInput,
  DesktopBoardGovernanceSetModeInput,
  DesktopBoardIntentDecisionInput,
} from "../ipc-types/board-governance.js";
import { buildRepoStatus } from "../repo-status.js";
import {
  startRepoStatusWatch,
  stopRepoStatusWatch,
} from "./repo-status-watch.js";
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
  getDesktopSupervisorGrantMetadata,
  provisionDesktopSupervisorGrant,
  readDesktopSupervisorGrantAgentKeysForEntries,
  revokeDesktopSupervisorGrant,
} from "./supervisor-grant.js";
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
import { listDesktopAgentProviderModels } from "./agents/managed-agent-models.js";
import {
  getDesktopManagedAgentChangeSummary,
  inspectDesktopManagedAgentSession,
  listDesktopManagedAgentSessions,
  resolveDesktopManagedAgentPermissionRequest,
  retryDesktopManagedAgent,
  startDesktopManagedAgent,
  stopDesktopManagedAgent,
} from "./agents/codex-supervisor.js";
import {
  onSupervisorActivity,
  supervisorDaemonClient,
} from "./supervisor-daemon.js";
import { supervisorGrantCoordinator } from "./supervisor-grant-coordinator.js";
import { emitToMainWindow } from "./window.js";
import { transferSupervisorOwnership } from "./supervisor-ownership.js";
import {
  classifyLaunchFailure,
  emitLaunchEvent,
  getLaunchEvents,
  LaunchBlockedError,
  onLaunchEvent,
  supervisedLaunchEverReady,
} from "./launch-events.js";
import {
  desktopSmokeControlTurn,
  desktopSmokeSupervisorEntries,
  isDesktopSmokeCheck,
} from "./smoke.js";
import {
  buildDiagnosticsSnapshot,
  buildWorkerSnapshots,
  clearJoinedRoomInfoCache,
  createDesktopInviteRoom,
  deleteDesktopAccountRoom,
  fetchRoomSnapshot,
  fetchRoomLiveMetadata,
  getDesktopGitHubEvents,
  getDesktopRoomArtifacts,
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
  createRepoRoomWorktree,
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
  getDesktopBoardGovernance,
  assignDesktopBoardManager,
  releaseDesktopBoardManager,
  setDesktopBoardManagerMode,
  decideDesktopBoardIntent,
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
import { openAllowedExternalUrl, openExternalWebUrl } from "./external-url.js";
import { getGitHubPullRequestStats } from "./github-pr-stats.js";
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

const { ipcMain } = electron as typeof import("electron");
let supervisorActivityBridgeRegistered = false;
let supervisorLaunchBridgeRegistered = false;

/** A launch id shared by the durable entry (`supervised_<id>`) and every launch
 * fact. Must satisfy the daemon's creation-request-id shape; fall back to a
 * fresh id when the renderer did not supply a usable one. */
function normalizeLaunchId(creationRequestId?: string | null): string {
  const candidate = creationRequestId?.trim();
  if (candidate && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}

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
      homePath: homedir(),
      apiUrl,
    }),
  );
  targetIpcMain.handle("desktop:supervisor-grant:revoke", async (): Promise<void> => revokeDesktopSupervisorGrant());
  targetIpcMain.handle(
    "desktop:app:open-github-url",
    async (_event, url: string): Promise<void> => {
      await openAllowedExternalUrl(url, ["github.com"]);
    },
  );
  targetIpcMain.handle(
    "desktop:app:open-external-url",
    async (_event, url: string): Promise<void> => {
      await openExternalWebUrl(url);
    },
  );
  targetIpcMain.handle(
    "desktop:app:get-github-pull-request-stats",
    async (_event, url: string) => getGitHubPullRequestStats(url),
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
    "desktop:room:get-board-governance",
    async (_event, roomIdentifier: string) => getDesktopBoardGovernance(roomIdentifier),
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
    "desktop:supervisor-grant:get",
    async (): Promise<DesktopSupervisorGrantMetadata | null> => getDesktopSupervisorGrantMetadata(),
  );
  targetIpcMain.handle(
    "desktop:supervisor-grant:provision",
    async (_event, input: DesktopProvisionSupervisorGrantInput): Promise<DesktopSupervisorGrantMetadata> => provisionDesktopSupervisorGrant(input),
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
    "desktop:repos:start-status-watch",
    async (_event, rootPath?: string | null): Promise<RepoStatus> => startRepoStatusWatch(rootPath || workspaceRoot),
  );
  targetIpcMain.handle(
    "desktop:repos:stop-status-watch",
    async (): Promise<void> => stopRepoStatusWatch(),
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
    "desktop:repos:create-worktree",
    async (
      _event,
      repoRoot?: string | null,
      branch?: string | null,
    ): Promise<DesktopRepoWorktreeResult> =>
      createRepoRoomWorktree(repoRoot || "", branch || ""),
  );
  targetIpcMain.handle(
    "desktop:workers:list",
    async (): Promise<WorkerSnapshot[]> => buildWorkerSnapshots(),
  );
  targetIpcMain.handle(
    "desktop:supervisor:get-status",
    async (): Promise<DesktopSupervisorDaemonStatus> => supervisorDaemonClient.ensureRunning(),
  );
  targetIpcMain.handle(
    "desktop:supervisor:list-agents",
    async (_event, roomIdentifier?: string | null): Promise<DesktopSupervisorManifestEntry[]> => {
      const entries = isDesktopSmokeCheck()
        ? desktopSmokeSupervisorEntries().filter((entry) => !roomIdentifier || entry.roomId === roomIdentifier)
        : await supervisorDaemonClient.list(roomIdentifier ?? null);
      const agentKeys = await readDesktopSupervisorGrantAgentKeysForEntries(
        entries.map((entry) => entry.id),
      ).catch(() => new Map<string, string>());
      return entries.map((entry) => ({
        ...entry,
        agentKey: entry.agentKey ?? agentKeys.get(entry.id) ?? null,
      }));
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:create-agent",
    async (_event, rawInput: DesktopSupervisorCreateInput): Promise<DesktopSupervisorManifestEntry> => {
      // Pin the launch id up front so every launch fact — and the durable entry
      // id (`supervised_<launchId>`) — shares one stable key across retries and
      // reopen. The renderer normally supplies it; fall back defensively.
      const launchId = normalizeLaunchId(rawInput.creationRequestId);
      const input: DesktopSupervisorCreateInput = { ...rawInput, creationRequestId: launchId };
      const entryId = `supervised_${launchId}`;
      const provider = input.providerId;
      const roomIdentifier = input.roomIdentifier;
      const launchFact = (
        type: Parameters<typeof emitLaunchEvent>[0]["type"],
        extra: { entryId?: string | null; detail?: string | null; recovery?: import("./launch-events.js").EmitLaunchEventInput["recovery"]; durable?: boolean } = {},
      ): void => {
        emitLaunchEvent({ launchId, roomIdentifier, provider, type, ...extra });
      };
      // The user clicked Start: the first server-side fact of this launch.
      launchFact("launch.requested", { entryId, detail: "You asked LetAgents to add this agent." });
      try {
        const storage = await getDesktopRoomStorage(roomIdentifier);
        if (storage.effectiveMode !== "cloud") {
          throw new LaunchBlockedError("Supervised agents need a cloud room. Publish or join a cloud room, or use the existing local agent path.", "choose_project");
        }
        if (provider !== "codex" && provider !== "claude-code") {
          throw new LaunchBlockedError(`Supervised ${provider} is not available yet: no background lifecycle is supported for this provider.`, "retry");
        }
        if (provider === "claude-code" && input.permissionProfileId === "ask_before_write") {
          throw new LaunchBlockedError("Supervised Claude Code cannot use Ask before writes yet: native permission prompts are not bridged. Choose Read-only or Full access.", "retry");
        }
        if (provider === "claude-code") {
          // Repair legacy `npx -y letagents` configs before the daemon launches
          // inside a pristine managed checkout named `letagents`.
          await refreshInstalledLetAgentsMcpServerAuth();
        }
        // Contact the background supervisor first so its (un)availability is an
        // honest, owner-visible fact rather than a hidden part of the claim.
        try {
          await supervisorDaemonClient.ensureRunning();
        } catch (error) {
          throw new LaunchBlockedError("LetAgents could not reach background agent management. Make sure the app can start its background service, then try again.", "reconnect");
        }
        launchFact("supervisor.connected", { entryId, detail: "Background agent management is available." });
        // Claim the lane durably first. Every legacy start consults this daemon
        // fence, so no new legacy owner may appear while transfer is in flight.
        return await transferSupervisorOwnership({
          claim: async () => {
            const { entry: manifest } = await supervisorGrantCoordinator.createPausedAndInstall(input);
            // The paused ownership claim is now persisted: setup survives an app
            // restart from here on.
            launchFact("agent.saved", { entryId: manifest.id, detail: "Your request is recorded and will survive an app restart.", durable: true });
            return manifest;
          },
          listLegacy: () => listDesktopManagedAgentSessions(roomIdentifier)
            .filter((session) => session.providerId === provider && !session.supervisorEntryId),
          stopLegacy: (session) => stopDesktopManagedAgent({ sessionId: session.id, stopMode: "worker" }).then(() => undefined),
          // Activation is the second durable CAS. The daemon, not Electron,
          // launches the native provider and remains authoritative after quit.
          activate: async (manifest) => {
            const activated = await supervisorDaemonClient.compareAndSetDesiredState(manifest.id, "paused", "running");
            if (!activated) throw new Error("The supervised launch changed while ownership was being transferred; it was not restarted.");
            launchFact("launch.activated", { entryId: manifest.id, detail: "LetAgents is now responsible for starting this agent.", durable: true });
            return activated;
          },
          rollback: (manifest) => supervisorDaemonClient.compareAndSetDesiredState(manifest.id, "paused", "stopped").then(() => undefined),
        });
      } catch (error) {
        const diagnostic = redactCredentialText(error instanceof Error ? error.message : String(error));
        console.error(`[supervised-launch:${entryId}] ${diagnostic.value}`);
        const failure = classifyLaunchFailure(error);
        launchFact(failure.type, { entryId, detail: failure.detail, recovery: failure.recovery });
        throw error;
      }
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:get-launch-events",
    async (_event, launchId: string, afterSequence?: number | null) =>
      getLaunchEvents(launchId, afterSequence ?? null),
  );
  targetIpcMain.handle(
    "desktop:supervisor:resume-ownership-transfer",
    async (_event, id: string): Promise<DesktopSupervisorManifestEntry> => {
      const entry = (await supervisorDaemonClient.list(null)).find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown supervised agent: ${id}`);
      if (entry.desiredState !== "paused") return entry;
      const launchId = id.startsWith("supervised_") ? id.slice("supervised_".length) : id;
      const launchFact = (
        type: Parameters<typeof emitLaunchEvent>[0]["type"],
        detail: string,
      ): void => {
        emitLaunchEvent({
          launchId,
          entryId: entry.id,
          roomIdentifier: entry.roomId,
          provider: entry.provider,
          type,
          detail,
          durable: true,
        });
      };
      launchFact("launch.requested", "You asked LetAgents to resume this saved launch.");
      try {
        if (entry.provider === "claude-code") await refreshInstalledLetAgentsMcpServerAuth();
        await supervisorDaemonClient.ensureRunning();
        await supervisorGrantCoordinator.prepareEntryForActivation(entry);
        launchFact("supervisor.connected", "Background agent management is available.");
        launchFact("agent.saved", "Your saved launch is ready to resume.");
        return await transferSupervisorOwnership({
          claim: async () => entry,
          listLegacy: () => listDesktopManagedAgentSessions(entry.roomId)
            .filter((session) => session.providerId === entry.provider && !session.supervisorEntryId),
          stopLegacy: (session) => stopDesktopManagedAgent({ sessionId: session.id, stopMode: "worker" }).then(() => undefined),
          activate: async (manifest) => {
            const activated = await supervisorDaemonClient.compareAndSetDesiredState(manifest.id, "paused", "running");
            if (!activated) throw new Error("The saved launch changed while ownership was being resumed; it was not restarted.");
            launchFact("launch.activated", "LetAgents resumed ownership of this agent.");
            return activated;
          },
          rollback: (manifest) => supervisorDaemonClient.compareAndSetDesiredState(manifest.id, "paused", "stopped").then(() => undefined),
        });
      } catch (error) {
        const failure = classifyLaunchFailure(error);
        emitLaunchEvent({
          launchId,
          entryId: entry.id,
          roomIdentifier: entry.roomId,
          provider: entry.provider,
          type: failure.type,
          detail: failure.detail,
          recovery: failure.recovery,
          durable: true,
        });
        throw error;
      }
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:set-desired-state",
    async (_event, id: string, desiredState: DesktopSupervisorDesiredState): Promise<DesktopSupervisorManifestEntry> => {
      if (desiredState === "running") await refreshInstalledLetAgentsMcpServerAuth();
      if (desiredState === "running") {
        const entry = (await supervisorDaemonClient.list(null)).find((candidate) => candidate.id === id);
        if (!entry) throw new Error(`Unknown supervised agent: ${id}`);
        await supervisorGrantCoordinator.prepareEntryForActivation(entry);
      }
      const updated = await supervisorDaemonClient.setDesiredState(id, desiredState);
      // Cancelling belongs to launch history only when the launch never reached
      // ready. "Ever ready" is durable/monotonic (readyReachedAt), so a launch
      // that reached ready and later degraded before Stop is still a lifecycle
      // stop (an agent event), while a bound-but-never-reachable pre-ready
      // attempt correctly records as a cancelled launch.
      if (desiredState === "stopped" && id.startsWith("supervised_")) {
        if (!supervisedLaunchEverReady(updated)) {
          emitLaunchEvent({
            launchId: id.slice("supervised_".length),
            entryId: id,
            roomIdentifier: updated.roomId,
            provider: updated.provider,
            type: "launch.cancelled",
            detail: "You stopped this launch.",
            durable: true,
          });
        }
      }
      return updated;
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:retry-room-delivery",
    async (_event, input: import("../ipc-types.js").DesktopSupervisorRoomDeliveryRetryInput): Promise<void> => {
      if (isDesktopSmokeCheck()) throw new Error("Room delivery retry is unavailable in the desktop smoke environment.");
      await supervisorDaemonClient.retryRoomDelivery(input);
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:reconnect-agent",
    async (_event, input: import("../ipc-types.js").DesktopSupervisorReconnectInput): Promise<DesktopSupervisorManifestEntry> => {
      if (isDesktopSmokeCheck()) throw new Error("Agent reconnection is unavailable in the desktop smoke environment.");
      const entry = (await supervisorDaemonClient.list(null)).find((candidate) => candidate.id === input.entryId);
      if (!entry) throw new Error(`Unknown supervised agent: ${input.entryId}`);
      await supervisorGrantCoordinator.reconnectEntry(entry);
      return (await supervisorDaemonClient.list(null)).find((candidate) => candidate.id === input.entryId) || entry;
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:control-turn",
    async (_event, input: import("../ipc-types.js").DesktopSupervisorTurnControlInput) =>
      isDesktopSmokeCheck() ? desktopSmokeControlTurn(input) : supervisorDaemonClient.controlTurn(input),
  );
  targetIpcMain.handle(
    "desktop:supervisor:resolve-turn-control",
    async (_event, input: import("../ipc-types.js").DesktopSupervisorTurnControlResolutionInput) =>
      supervisorDaemonClient.resolveTurnControl(input),
  );
  targetIpcMain.handle(
    "desktop:supervisor:read-attempt",
    async (_event, id: string): Promise<DesktopSupervisorAttemptDetail> => supervisorDaemonClient.readAttempt(id),
  );
  targetIpcMain.handle(
    "desktop:supervisor:get-agent-inspector-detail",
    async (_event, input: import("../ipc-types.js").DesktopSupervisorAgentInspectorDetailInput): Promise<import("../ipc-types.js").DesktopSupervisorAgentInspectorDetail> => {
      if (isDesktopSmokeCheck()) throw new Error("Agent inspector detail history is unavailable in the desktop smoke environment.");
      return supervisorDaemonClient.getAgentInspectorDetail(input);
    },
  );
  targetIpcMain.handle("desktop:supervisor:get-agent-configuration", async (_event, input: { entryId: string; daemonGeneration: number }) =>
    supervisorDaemonClient.getAgentConfiguration(input.entryId, input.daemonGeneration));
  targetIpcMain.handle("desktop:supervisor:update-agent-configuration", async (_event, input: import("../ipc-types.js").DesktopSupervisorAgentConfigurationUpdateInput) =>
    supervisorDaemonClient.updateAgentConfiguration(input));
  targetIpcMain.handle("desktop:supervisor:prepare-room-move", async (_event, input: import("../ipc-types.js").DesktopSupervisorRoomMovePrepareInput) =>
    supervisorDaemonClient.prepareRoomMove(input));
  targetIpcMain.handle("desktop:supervisor:commit-room-move", async (_event, input: import("../ipc-types.js").DesktopSupervisorRoomMoveOperationInput) =>
    supervisorDaemonClient.commitRoomMove(input));
  targetIpcMain.handle("desktop:supervisor:get-room-move", async (_event, input: import("../ipc-types.js").DesktopSupervisorRoomMoveOperationInput) =>
    supervisorDaemonClient.getRoomMove(input));
  targetIpcMain.handle("desktop:supervisor:retire-agent", async (_event, input: { entryId: string; daemonGeneration: number }) =>
    supervisorDaemonClient.retireAgent(input.entryId, input.daemonGeneration));
  targetIpcMain.handle("desktop:supervisor:purge-agent", async (_event, input: { entryId: string; daemonGeneration: number }) => {
    const prepared = await supervisorDaemonClient.purgeAgent(input.entryId, input.daemonGeneration, false);
    if (prepared.outcome !== "revocation_required") return prepared;
    await supervisorGrantCoordinator.revokeEntryForPurge(input.entryId);
    const committed = await supervisorDaemonClient.purgeAgent(input.entryId, input.daemonGeneration, true);
    return committed.outcome === "revocation_required" ? { outcome: "invalid" as const, error: "Purge credential revocation was not durably acknowledged." } : committed;
  });
  if (!supervisorActivityBridgeRegistered) {
    supervisorActivityBridgeRegistered = true;
    onSupervisorActivity((payload) => emitToMainWindow("desktop:supervisor:activity", payload));
  }
  if (!supervisorLaunchBridgeRegistered) {
    supervisorLaunchBridgeRegistered = true;
    onLaunchEvent((event) => emitToMainWindow("desktop:supervisor:launch-event", event));
  }
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
    "desktop:workers:retry-managed-agent",
    async (
      _event,
      input: DesktopManagedAgentRetryInput,
    ): Promise<DesktopManagedAgentSession | null> => retryDesktopManagedAgent(input),
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
    "desktop:workers:get-managed-agent-change-summary",
    async (
      _event,
      sessionId?: string | null,
      roomIdentifier?: string | null,
    ): Promise<DesktopManagedAgentChangeSummary | null> =>
      getDesktopManagedAgentChangeSummary(sessionId ?? null, roomIdentifier ?? null),
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
    "desktop:workers:list-agent-provider-models",
    async (
      _event,
      providerId: DesktopAgentProviderId,
      input?: DesktopAgentProviderPreflightInput,
    ): Promise<DesktopAgentProviderModelsResult> =>
      listDesktopAgentProviderModels(providerId, input ?? {}),
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
