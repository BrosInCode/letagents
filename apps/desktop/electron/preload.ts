import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./ipc-types.js";

const api: DesktopApi = {
  ui: {
    onOpenSettings: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("desktop:ui:open-settings", listener);
      return () => {
        ipcRenderer.off("desktop:ui:open-settings", listener);
      };
    },
  },
  app: {
    getInfo: () => ipcRenderer.invoke("desktop:app:get-info"),
    openGitHubUrl: (url: string) => ipcRenderer.invoke("desktop:app:open-github-url", url),
    openExternalUrl: (url: string) => ipcRenderer.invoke("desktop:app:open-external-url", url),
    getGitHubPullRequestStats: (url: string) =>
      ipcRenderer.invoke("desktop:app:get-github-pull-request-stats", url),
  },
  appAgent: {
    getSettingsStatus: () =>
      ipcRenderer.invoke("desktop:app-agent:get-settings-status"),
    saveSettings: (input) =>
      ipcRenderer.invoke("desktop:app-agent:save-settings", input),
    listActions: () => ipcRenderer.invoke("desktop:app-agent:list-actions"),
    run: (input) => ipcRenderer.invoke("desktop:app-agent:run", input),
  },
  openModel: {
    getSettingsStatus: () =>
      ipcRenderer.invoke("desktop:open-model:get-settings-status"),
    saveSettings: (input) =>
      ipcRenderer.invoke("desktop:open-model:save-settings", input),
  },
  room: {
    listAccountRooms: (options) => ipcRenderer.invoke("desktop:room:list-account-rooms", options ?? {}),
    updateAccountRoom: (roomIdentifier: string, updates) =>
      ipcRenderer.invoke("desktop:room:update-account-room", roomIdentifier, updates),
    leaveAccountRoom: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:room:leave-account-room", roomIdentifier),
    deleteAccountRoom: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:room:delete-account-room", roomIdentifier),
    getSnapshot: (roomIdentifier?: string | null) => ipcRenderer.invoke("desktop:room:get-snapshot", roomIdentifier ?? null),
    getLiveMetadata: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:room:get-live-metadata", roomIdentifier),
    getLatestMessages: (roomIdentifiers: string[]) =>
      ipcRenderer.invoke("desktop:room:get-latest-messages", roomIdentifiers),
    getMessagesBefore: (roomIdentifier: string, beforeMessageId: string, limit?: number) =>
      ipcRenderer.invoke("desktop:room:get-messages-before", roomIdentifier, beforeMessageId, limit ?? 150),
    getThreads: (roomIdentifier: string, filter = "all", beforeMessageId?: string | null, limit?: number) =>
      ipcRenderer.invoke("desktop:room:get-threads", roomIdentifier, filter, beforeMessageId ?? null, limit ?? 150),
    getThread: (roomIdentifier: string, threadRootId: string, beforeMessageId?: string | null, limit?: number) =>
      ipcRenderer.invoke("desktop:room:get-thread", roomIdentifier, threadRootId, beforeMessageId ?? null, limit ?? 150),
    markThreadRead: (roomIdentifier: string, threadRootId: string, messageId?: string | null) =>
      ipcRenderer.invoke("desktop:room:mark-thread-read", roomIdentifier, threadRootId, messageId ?? null),
    getReasoningSession: (roomIdentifier: string, sessionId: string) =>
      ipcRenderer.invoke("desktop:room:get-reasoning-session", roomIdentifier, sessionId),
    pickAttachments: (roomIdentifier: string) => ipcRenderer.invoke("desktop:room:pick-attachments", roomIdentifier),
    stageDroppedAttachmentContents: (roomIdentifier, files) =>
      ipcRenderer.invoke("desktop:room:stage-dropped-attachment-contents", roomIdentifier, files),
    discardAttachment: (roomIdentifier: string, uploadId: string) =>
      ipcRenderer.invoke("desktop:room:discard-attachment", roomIdentifier, uploadId),
    startStream: (roomIdentifier: string, afterMessageId?: string | null) =>
      ipcRenderer.invoke("desktop:room:start-stream", roomIdentifier, afterMessageId ?? null),
    stopStream: (roomIdentifier?: string | null) => ipcRenderer.invoke("desktop:room:stop-stream", roomIdentifier ?? null),
    onStreamEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("desktop:room:stream-event", listener);
      return () => {
        ipcRenderer.off("desktop:room:stream-event", listener);
      };
    },
    sendMessage: (
      roomIdentifier: string,
      text: string,
      replyTo?: string | null,
      attachments?: Array<{ upload_id: string }>,
      threadRootId?: string | null,
    ) =>
      ipcRenderer.invoke("desktop:room:send-message", roomIdentifier, text, replyTo ?? null, attachments ?? [], threadRootId ?? null),
    addTask: (roomIdentifier: string, input) =>
      ipcRenderer.invoke("desktop:room:add-task", roomIdentifier, input),
    updateTask: (roomIdentifier: string, taskId: string, updates) =>
      ipcRenderer.invoke("desktop:room:update-task", roomIdentifier, taskId, updates),
    updateTaskLease: (roomIdentifier: string, taskId: string, input) =>
      ipcRenderer.invoke("desktop:room:update-task-lease", roomIdentifier, taskId, input),
    updateTaskReviewLease: (roomIdentifier: string, taskId: string, input) =>
      ipcRenderer.invoke("desktop:room:update-task-review-lease", roomIdentifier, taskId, input),
    runTaskWorkerAction: (roomIdentifier: string, taskId: string, input) =>
      ipcRenderer.invoke("desktop:room:run-task-worker-action", roomIdentifier, taskId, input),
    runTaskReviewWorkerAction: (roomIdentifier: string, taskId: string, input) =>
      ipcRenderer.invoke("desktop:room:run-task-review-worker-action", roomIdentifier, taskId, input),
    getBoardGovernance: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:room:get-board-governance", roomIdentifier),
    assignBoardManager: (roomIdentifier: string, input) =>
      ipcRenderer.invoke("desktop:room:assign-board-manager", roomIdentifier, input),
    releaseBoardManager: (roomIdentifier: string, input) =>
      ipcRenderer.invoke("desktop:room:release-board-manager", roomIdentifier, input ?? {}),
    setBoardManagerMode: (roomIdentifier: string, input) =>
      ipcRenderer.invoke("desktop:room:set-board-manager-mode", roomIdentifier, input),
    decideBoardIntent: (roomIdentifier: string, intentId: string, input) =>
      ipcRenderer.invoke("desktop:room:decide-board-intent", roomIdentifier, intentId, input),
    createTaskFocusRoom: (roomIdentifier: string, taskId: string) =>
      ipcRenderer.invoke("desktop:room:create-task-focus-room", roomIdentifier, taskId),
    createAdHocFocusRoom: (roomIdentifier: string, title: string) =>
      ipcRenderer.invoke("desktop:room:create-ad-hoc-focus-room", roomIdentifier, title),
    updateFocusRoomSettings: (roomIdentifier: string, focusKey: string, settings) =>
      ipcRenderer.invoke("desktop:room:update-focus-room-settings", roomIdentifier, focusKey, settings),
    concludeFocusRoom: (roomIdentifier: string, focusKey: string, summary: string, details) =>
      ipcRenderer.invoke("desktop:room:conclude-focus-room", roomIdentifier, focusKey, summary, details),
    archiveFocusRoom: (roomIdentifier: string, focusKey: string) =>
      ipcRenderer.invoke("desktop:room:archive-focus-room", roomIdentifier, focusKey),
    rename: (roomIdentifier: string, displayName: string) =>
      ipcRenderer.invoke("desktop:room:rename", roomIdentifier, displayName),
    createInviteRoom: () => ipcRenderer.invoke("desktop:room:create-invite-room"),
    getGitHubEvents: (roomIdentifier: string, query = {}) =>
      ipcRenderer.invoke("desktop:room:get-github-events", roomIdentifier, query),
    getArtifacts: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:room:get-artifacts", roomIdentifier),
    getGitHubIntegrationStatus: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:room:get-github-integration-status", roomIdentifier),
    openGitHubInstall: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:room:open-github-install", roomIdentifier),
  },
  chatStorage: {
    getSettings: () => ipcRenderer.invoke("desktop:chat-storage:get-settings"),
    setMode: (mode) => ipcRenderer.invoke("desktop:chat-storage:set-mode", mode),
    getRoomStorage: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:chat-storage:get-room-storage", roomIdentifier),
    setRoomMode: (roomIdentifier, mode) =>
      ipcRenderer.invoke("desktop:chat-storage:set-room-mode", roomIdentifier, mode),
    createLocalRoom: (input) =>
      ipcRenderer.invoke("desktop:chat-storage:create-local-room", input ?? {}),
    forkRoomToLocal: (roomIdentifier) =>
      ipcRenderer.invoke("desktop:chat-storage:fork-room-to-local", roomIdentifier),
    publishLocalRoom: (roomIdentifier) =>
      ipcRenderer.invoke("desktop:chat-storage:publish-local-room", roomIdentifier),
    syncLocalRoom: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:chat-storage:sync-local-room", roomIdentifier),
  },
  rental: {
    listListings: (input) => ipcRenderer.invoke("desktop:rental:list-listings", input ?? {}),
    getProviderDashboard: () => ipcRenderer.invoke("desktop:rental:get-provider-dashboard"),
    createListing: (input) => ipcRenderer.invoke("desktop:rental:create-listing", input),
    updateListing: (id, input) => ipcRenderer.invoke("desktop:rental:update-listing", id, input),
    pauseListing: (id) => ipcRenderer.invoke("desktop:rental:pause-listing", id),
    resumeListing: (id) => ipcRenderer.invoke("desktop:rental:resume-listing", id),
    refreshQuota: (id) => ipcRenderer.invoke("desktop:rental:refresh-quota", id),
    runPreflight: (id?: string) => ipcRenderer.invoke("desktop:rental:run-preflight", id ?? null),
    createSession: (input) => ipcRenderer.invoke("desktop:rental:create-session", input),
    getSession: (id) => ipcRenderer.invoke("desktop:rental:get-session", id),
    cancelSession: (id) => ipcRenderer.invoke("desktop:rental:cancel-session", id),
    listProviderRequests: () => ipcRenderer.invoke("desktop:rental:list-provider-requests"),
    acceptRequest: (id) => ipcRenderer.invoke("desktop:rental:accept-request", id),
    declineRequest: (id, reason?: string) => ipcRenderer.invoke("desktop:rental:decline-request", id, reason ?? null),
    getActivity: (sessionId) => ipcRenderer.invoke("desktop:rental:get-activity", sessionId),
    getExposures: (sessionId) => ipcRenderer.invoke("desktop:rental:get-exposures", sessionId),
    getContextRequests: (sessionId) => ipcRenderer.invoke("desktop:rental:get-context-requests", sessionId),
    getPatches: (sessionId) => ipcRenderer.invoke("desktop:rental:get-patches", sessionId),
    getUsage: (sessionId) => ipcRenderer.invoke("desktop:rental:get-usage", sessionId),
    getOwnQuotaStatus: () => ipcRenderer.invoke("desktop:rental:get-own-quota-status"),
    declareQuotaExhausted: (input) => ipcRenderer.invoke("desktop:rental:declare-quota-exhausted", input ?? {}),
    approvePatch: (sessionId, patchId) => ipcRenderer.invoke("desktop:rental:approve-patch", sessionId, patchId),
    requestPatchChanges: (sessionId, patchId, note) =>
      ipcRenderer.invoke("desktop:rental:request-patch-changes", sessionId, patchId, note),
    approveContextRequest: (sessionId, approvalId) =>
      ipcRenderer.invoke("desktop:rental:approve-context-request", sessionId, approvalId),
    denyContextRequest: (sessionId, approvalId) =>
      ipcRenderer.invoke("desktop:rental:deny-context-request", sessionId, approvalId),
  },
  auth: {
    getStatus: () => ipcRenderer.invoke("desktop:auth:get-status"),
    startDeviceFlow: (roomIdentifier?: string | null) =>
      ipcRenderer.invoke("desktop:auth:start-device-flow", roomIdentifier ?? null),
    pollDeviceFlow: (requestId?: string | null) =>
      ipcRenderer.invoke("desktop:auth:poll-device-flow", requestId ?? null),
    openVerification: (url: string) => ipcRenderer.invoke("desktop:auth:open-verification", url),
    signOut: () => ipcRenderer.invoke("desktop:auth:sign-out"),
  },
  supervisorGrant: {
    get: () => ipcRenderer.invoke("desktop:supervisor-grant:get"),
    provision: (input) => ipcRenderer.invoke("desktop:supervisor-grant:provision", input),
    revoke: () => ipcRenderer.invoke("desktop:supervisor-grant:revoke"),
  },
  setup: {
    getMcpInstallState: () => ipcRenderer.invoke("desktop:setup:get-mcp-install-state"),
    installMcpServer: (targetId) =>
      ipcRenderer.invoke("desktop:setup:install-mcp-server", targetId),
    installMcpServers: (targetIds) =>
      ipcRenderer.invoke("desktop:setup:install-mcp-servers", targetIds),
    completeMcpOnboarding: () => ipcRenderer.invoke("desktop:setup:complete-mcp-onboarding"),
  },
  repos: {
    getStatus: (rootPath) => ipcRenderer.invoke("desktop:repos:get-status", rootPath || null),
    startStatusWatch: (rootPath) => ipcRenderer.invoke("desktop:repos:start-status-watch", rootPath),
    stopStatusWatch: () => ipcRenderer.invoke("desktop:repos:stop-status-watch"),
    onStatusChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("desktop:repos:status-changed", listener);
      return () => {
        ipcRenderer.off("desktop:repos:status-changed", listener);
      };
    },
    openRoom: (rootPath) => ipcRenderer.invoke("desktop:repos:open-room", rootPath),
    pickRoom: () => ipcRenderer.invoke("desktop:repos:pick-room"),
    createWorktree: (repoRoot, branch) =>
      ipcRenderer.invoke("desktop:repos:create-worktree", repoRoot, branch),
  },
  workers: {
    list: () => ipcRenderer.invoke("desktop:workers:list"),
    listManagedAgentSessions: (roomIdentifier) =>
      ipcRenderer.invoke("desktop:workers:list-managed-agent-sessions", roomIdentifier || null),
    onManagedAgentSessionUpdate: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("desktop:workers:managed-agent-session", listener);
      return () => {
        ipcRenderer.off("desktop:workers:managed-agent-session", listener);
      };
    },
    startManagedAgent: (input) =>
      ipcRenderer.invoke("desktop:workers:start-managed-agent", input),
    stopManagedAgent: (input = {}) =>
      ipcRenderer.invoke("desktop:workers:stop-managed-agent", input),
    retryManagedAgent: (input) =>
      ipcRenderer.invoke("desktop:workers:retry-managed-agent", input),
    inspectManagedAgent: (sessionId = null, roomIdentifier = null) =>
      ipcRenderer.invoke("desktop:workers:inspect-managed-agent", sessionId, roomIdentifier),
    getManagedAgentChangeSummary: (sessionId = null, roomIdentifier = null) =>
      ipcRenderer.invoke("desktop:workers:get-managed-agent-change-summary", sessionId, roomIdentifier),
    resolveManagedAgentPermission: (input) =>
      ipcRenderer.invoke("desktop:workers:resolve-managed-agent-permission", input),
    listAgentProviders: () => ipcRenderer.invoke("desktop:workers:list-agent-providers"),
    listAgentProviderModels: (providerId, input = {}) =>
      ipcRenderer.invoke("desktop:workers:list-agent-provider-models", providerId, input),
    runAgentProviderPreflight: (providerId, input = {}) =>
      ipcRenderer.invoke("desktop:workers:run-agent-provider-preflight", providerId, input),
    runAgentProviderSetup: (providerId, input) =>
      ipcRenderer.invoke("desktop:workers:run-agent-provider-setup", providerId, input),
  },
  supervisor: {
    getStatus: () => ipcRenderer.invoke("desktop:supervisor:get-status"),
    listAgents: (roomIdentifier) => ipcRenderer.invoke("desktop:supervisor:list-agents", roomIdentifier ?? null),
    createAgent: (input) => ipcRenderer.invoke("desktop:supervisor:create-agent", input),
    resumeOwnershipTransfer: (id) => ipcRenderer.invoke("desktop:supervisor:resume-ownership-transfer", id),
    setDesiredState: (id, desiredState) => ipcRenderer.invoke("desktop:supervisor:set-desired-state", id, desiredState),
    reconnectAgent: (input) => ipcRenderer.invoke("desktop:supervisor:reconnect-agent", input),
    retryRoomDelivery: (input) => ipcRenderer.invoke("desktop:supervisor:retry-room-delivery", input),
    controlTurn: (input) => ipcRenderer.invoke("desktop:supervisor:control-turn", input),
    resolveTurnControl: (input) => ipcRenderer.invoke("desktop:supervisor:resolve-turn-control", input),
    readAttempt: (id) => ipcRenderer.invoke("desktop:supervisor:read-attempt", id),
    onActivity: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("desktop:supervisor:activity", listener);
      return () => ipcRenderer.off("desktop:supervisor:activity", listener);
    },
    onLaunchEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("desktop:supervisor:launch-event", listener);
      return () => ipcRenderer.off("desktop:supervisor:launch-event", listener);
    },
    getLaunchEvents: (launchId, afterSequence) =>
      ipcRenderer.invoke("desktop:supervisor:get-launch-events", launchId, afterSequence ?? null),
  },
  diagnostics: {
    getSnapshot: () => ipcRenderer.invoke("desktop:diagnostics:get-snapshot"),
  },
};

contextBridge.exposeInMainWorld("letagentsDesktop", api);
