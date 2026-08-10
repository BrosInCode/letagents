import type { DesktopAuthPollResult, DesktopAuthStartResult, DesktopAuthStatus } from "./auth.js";
import type { DesktopNotificationStatus, DesktopNotificationTarget } from "./notifications.js";
import type { DesktopProvisionSupervisorGrantInput, DesktopSupervisorGrantMetadata } from "./supervisor-grant.js";
import type {
  DesktopAppInfo,
  DesktopGitHubPullRequestStats,
  DesktopRepoWorktreeResult,
  DiagnosticsSnapshot,
  RepoStatus,
  WorkerSnapshot,
} from "./core.js";
import type {
  DesktopAppAgentActionMetadata,
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
  DesktopAppAgentSaveSettingsInput,
  DesktopAppAgentSettingsStatus,
} from "./app-agent.js";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopAgentProviderSetupInput,
  DesktopAgentProviderSetupResult,
  DesktopManagedAgentChangeSummary,
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentPermissionDecisionInput,
  DesktopManagedAgentPermissionDecisionResult,
  DesktopManagedAgentRetryInput,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
  DesktopSupervisorAttemptDetail,
  DesktopSupervisorAgentConfiguration,
  DesktopSupervisorAgentConfigurationUpdateInput,
  DesktopSupervisorAgentConfigurationUpdateResult,
  DesktopSupervisorRoomMove,
  DesktopSupervisorCurrentRoomMoveInput,
  DesktopSupervisorRoomMoveOperationInput,
  DesktopSupervisorRoomMovePrepareInput,
  DesktopSupervisorCreateInput,
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorDesiredState,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorTurnControlInput,
  DesktopSupervisorTurnControlResolutionInput,
  DesktopSupervisorTurnControlResult,
  DesktopOpenModelSaveSettingsInput,
  DesktopOpenModelSettingsStatus,
} from "./agents.js";
import type { DesktopRentalApi } from "./rental.js";
import type {
  DesktopAccountRoomActionResult,
  DesktopAccountRoomEntry,
  DesktopAccountRoomListOptions,
  DesktopDroppedAttachmentContent,
  DesktopFocusRoomConclusionDetails,
  DesktopFocusRoomMutationResult,
  DesktopFocusRoomSettingsPatch,
  DesktopGitHubEventsPage,
  DesktopGitHubEventsQuery,
  DesktopGitHubIntegrationActionResult,
  DesktopGitHubIntegrationStatus,
  DesktopChatStorageSettings,
  DesktopLocalRoomMutationResult,
  DesktopLocalChatSyncResult,
  DesktopRoomStorageOverrideMode,
  DesktopRoomStorageState,
  DesktopInviteRoomCreation,
  DesktopRepoRoomSelection,
  DesktopRoomInfo,
  DesktopRoomLatestMessage,
  DesktopMessageInfo,
  DesktopRoomMessage,
  DesktopRoomMessagesPage,
  DesktopRoomThreadInboxFilter,
  DesktopRoomThreadInboxPage,
  DesktopRoomThreadPage,
  DesktopRoomThreadReadResult,
  DesktopRoomLiveMetadata,
  DesktopRoomSharedArtifact,
  DesktopRoomSnapshot,
  DesktopRoomStreamEvent,
  DesktopSendRoomMessageResult,
  DesktopStagedAttachment,
} from "./room.js";
import type { DesktopMcpInstallManyResult, DesktopMcpInstallResult, DesktopMcpInstallState, DesktopMcpInstallTargetId } from "./setup.js";
import type {
  DesktopReasoningSessionDetail,
} from "./activity.js";
import type { DesktopUpdateStatus } from "./updates.js";
import type {
  DesktopTaskCreateInput,
  DesktopTaskLeaseActionInput,
  DesktopTaskMutationResult,
  DesktopTaskReviewLeaseActionInput,
  DesktopTaskReviewWorkerActionInput,
  DesktopTaskWorkerActionInput,
} from "./tasks.js";
import type {
  DesktopBoardGovernanceAssignManagerInput,
  DesktopBoardGovernanceMutationResult,
  DesktopBoardGovernanceReleaseManagerInput,
  DesktopBoardGovernanceSetModeInput,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardIntentDecisionInput,
} from "./board-governance.js";

export interface DesktopApi {
  ui: {
    onOpenSettings: (callback: () => void) => () => void;
    onOpenUpdates?: (callback: () => void) => () => void;
  };
  notifications: {
    getStatus: () => Promise<DesktopNotificationStatus>;
    setEnabled: (enabled: boolean) => Promise<DesktopNotificationStatus>;
    takePendingActivation: () => Promise<DesktopNotificationTarget | null>;
    onActivated: (callback: (target: DesktopNotificationTarget) => void) => () => void;
    onStatusChanged: (callback: (status: DesktopNotificationStatus) => void) => () => void;
  };
  app: {
    getInfo: () => Promise<DesktopAppInfo>;
    openGitHubUrl: (url: string) => Promise<void>;
    openExternalUrl: (url: string) => Promise<void>;
    getGitHubPullRequestStats: (url: string) => Promise<DesktopGitHubPullRequestStats | null>;
  };
  updates?: {
    getStatus: () => Promise<DesktopUpdateStatus>;
    check: () => Promise<DesktopUpdateStatus>;
    install: () => Promise<DesktopUpdateStatus>;
    onStatusChanged: (callback: (status: DesktopUpdateStatus) => void) => () => void;
  };
  appAgent: {
    getSettingsStatus: () => Promise<DesktopAppAgentSettingsStatus>;
    saveSettings: (input: DesktopAppAgentSaveSettingsInput) => Promise<DesktopAppAgentSettingsStatus>;
    listActions: () => Promise<DesktopAppAgentActionMetadata[]>;
    run: (input: DesktopAppAgentRunInput) => Promise<DesktopAppAgentRunResult>;
  };
  openModel: {
    getSettingsStatus: () => Promise<DesktopOpenModelSettingsStatus>;
    saveSettings: (input: DesktopOpenModelSaveSettingsInput) => Promise<DesktopOpenModelSettingsStatus>;
  };
  room: {
    listAccountRooms: (options?: DesktopAccountRoomListOptions) => Promise<DesktopAccountRoomEntry[]>;
    updateAccountRoom: (
      roomIdentifier: string,
      updates: { pinned?: boolean; archived?: boolean }
    ) => Promise<DesktopAccountRoomActionResult>;
    leaveAccountRoom: (roomIdentifier: string) => Promise<DesktopAccountRoomActionResult>;
    deleteAccountRoom: (roomIdentifier: string) => Promise<DesktopAccountRoomActionResult>;
    getSnapshot: (roomIdentifier?: string | null) => Promise<DesktopRoomSnapshot>;
    /**
     * Optional: absent on a stale live bridge (renderer updated before the
     * preload was reloaded). Callers must skip gracefully when missing.
     */
    getLiveMetadata?: (roomIdentifier: string) => Promise<DesktopRoomLiveMetadata>;
    getLatestMessages: (roomIdentifiers: string[]) => Promise<DesktopRoomLatestMessage[]>;
    getMessage: (roomIdentifier: string, messageId: string) => Promise<DesktopRoomMessage | null>;
    getMessageInfo: (roomIdentifier: string, messageId: string) => Promise<DesktopMessageInfo | null>;
    getMessagesBefore: (roomIdentifier: string, beforeMessageId: string, limit?: number) => Promise<DesktopRoomMessagesPage>;
    getThreads: (roomIdentifier: string, filter?: DesktopRoomThreadInboxFilter, beforeMessageId?: string | null, limit?: number) => Promise<DesktopRoomThreadInboxPage>;
    getThread: (roomIdentifier: string, threadRootId: string, beforeMessageId?: string | null, limit?: number) => Promise<DesktopRoomThreadPage>;
    markThreadRead: (roomIdentifier: string, threadRootId: string, messageId?: string | null) => Promise<DesktopRoomThreadReadResult>;
    getReasoningSession: (roomIdentifier: string, sessionId: string) => Promise<DesktopReasoningSessionDetail>;
    pickAttachments: (roomIdentifier: string) => Promise<DesktopStagedAttachment[]>;
    stageDroppedAttachmentContents?: (
      roomIdentifier: string,
      files: DesktopDroppedAttachmentContent[]
    ) => Promise<DesktopStagedAttachment[]>;
    discardAttachment: (roomIdentifier: string, uploadId: string) => Promise<void>;
    startStream: (roomIdentifier: string, afterMessageId?: string | null) => Promise<void>;
    stopStream: (roomIdentifier?: string | null) => Promise<void>;
    onStreamEvent: (callback: (event: DesktopRoomStreamEvent) => void) => () => void;
    sendMessage: (
      roomIdentifier: string,
      text: string,
      replyTo?: string | null,
      attachments?: Array<{ upload_id: string }>,
      threadRootId?: string | null
    ) => Promise<DesktopSendRoomMessageResult>;
    addTask: (roomIdentifier: string, input: DesktopTaskCreateInput) => Promise<DesktopTaskMutationResult>;
    updateTask: (
      roomIdentifier: string,
      taskId: string,
      updates: { status?: string; assignee?: string | null; pr_url?: string | null }
    ) => Promise<DesktopTaskMutationResult>;
    updateTaskLease: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskLeaseActionInput
    ) => Promise<DesktopTaskMutationResult>;
    updateTaskReviewLease: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskReviewLeaseActionInput
    ) => Promise<DesktopTaskMutationResult>;
    runTaskWorkerAction: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskWorkerActionInput
    ) => Promise<DesktopTaskMutationResult>;
    runTaskReviewWorkerAction: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskReviewWorkerActionInput
    ) => Promise<DesktopTaskMutationResult>;
    getBoardGovernance: (roomIdentifier: string) => Promise<DesktopBoardGovernanceSnapshot>;
    assignBoardManager: (
      roomIdentifier: string,
      input: DesktopBoardGovernanceAssignManagerInput
    ) => Promise<DesktopBoardGovernanceMutationResult>;
    releaseBoardManager: (
      roomIdentifier: string,
      input?: DesktopBoardGovernanceReleaseManagerInput
    ) => Promise<DesktopBoardGovernanceMutationResult>;
    setBoardManagerMode: (
      roomIdentifier: string,
      input: DesktopBoardGovernanceSetModeInput
    ) => Promise<DesktopBoardGovernanceMutationResult>;
    decideBoardIntent: (
      roomIdentifier: string,
      intentId: string,
      input: DesktopBoardIntentDecisionInput
    ) => Promise<DesktopBoardGovernanceMutationResult>;
    createTaskFocusRoom: (
      roomIdentifier: string,
      taskId: string
    ) => Promise<DesktopFocusRoomMutationResult>;
    createAdHocFocusRoom: (
      roomIdentifier: string,
      title: string
    ) => Promise<DesktopFocusRoomMutationResult>;
    updateFocusRoomSettings: (
      roomIdentifier: string,
      focusKey: string,
      settings: DesktopFocusRoomSettingsPatch
    ) => Promise<DesktopFocusRoomMutationResult>;
    concludeFocusRoom: (
      roomIdentifier: string,
      focusKey: string,
      summary: string,
      details: DesktopFocusRoomConclusionDetails | null,
      quickClose: boolean,
    ) => Promise<DesktopFocusRoomMutationResult>;
    archiveFocusRoom: (
      roomIdentifier: string,
      focusKey: string
    ) => Promise<DesktopFocusRoomMutationResult>;
    rename: (roomIdentifier: string, displayName: string) => Promise<DesktopRoomInfo>;
    createInviteRoom: () => Promise<DesktopInviteRoomCreation>;
    getGitHubEvents: (
      roomIdentifier: string,
      query?: DesktopGitHubEventsQuery,
    ) => Promise<DesktopGitHubEventsPage>;
    getArtifacts?: (roomIdentifier: string) => Promise<DesktopRoomSharedArtifact[]>;
    getGitHubIntegrationStatus: (roomIdentifier: string) => Promise<DesktopGitHubIntegrationStatus>;
    openGitHubInstall: (roomIdentifier: string) => Promise<DesktopGitHubIntegrationActionResult>;
  };
  chatStorage: {
    getSettings: () => Promise<DesktopChatStorageSettings>;
    setMode: (mode: DesktopChatStorageSettings["mode"]) => Promise<DesktopChatStorageSettings>;
    getRoomStorage: (roomIdentifier: string) => Promise<DesktopRoomStorageState>;
    setRoomMode: (
      roomIdentifier: string,
      mode: DesktopRoomStorageOverrideMode
    ) => Promise<DesktopRoomStorageState>;
    createLocalRoom: (input?: { displayName?: string | null }) => Promise<DesktopLocalRoomMutationResult>;
    forkRoomToLocal: (roomIdentifier: string) => Promise<DesktopLocalRoomMutationResult>;
    publishLocalRoom: (roomIdentifier: string) => Promise<DesktopLocalChatSyncResult>;
    syncLocalRoom: (roomIdentifier: string) => Promise<DesktopLocalChatSyncResult>;
  };
  rental?: DesktopRentalApi;
  auth: {
    getStatus: () => Promise<DesktopAuthStatus>;
    startDeviceFlow: (roomIdentifier?: string | null) => Promise<DesktopAuthStartResult>;
    pollDeviceFlow: (requestId?: string | null) => Promise<DesktopAuthPollResult>;
    openVerification: (url: string) => Promise<void>;
    signOut: () => Promise<DesktopAuthStatus>;
  };
  supervisorGrant: {
    get: () => Promise<DesktopSupervisorGrantMetadata | null>;
    provision: (input: DesktopProvisionSupervisorGrantInput) => Promise<DesktopSupervisorGrantMetadata>;
    revoke: () => Promise<void>;
  };
  setup: {
    getMcpInstallState: () => Promise<DesktopMcpInstallState>;
    installMcpServer: (targetId: DesktopMcpInstallTargetId) => Promise<DesktopMcpInstallResult>;
    installMcpServers: (targetIds: DesktopMcpInstallTargetId[]) => Promise<DesktopMcpInstallManyResult>;
    completeMcpOnboarding: () => Promise<DesktopMcpInstallState>;
  };
  repos: {
    getStatus: (rootPath?: string | null) => Promise<RepoStatus>;
    startStatusWatch: (rootPath: string) => Promise<RepoStatus>;
    stopStatusWatch: () => Promise<void>;
    onStatusChanged: (callback: (status: RepoStatus) => void) => () => void;
    openRoom: (rootPath: string) => Promise<DesktopRepoRoomSelection>;
    pickRoom: () => Promise<DesktopRepoRoomSelection>;
    createWorktree: (repoRoot: string, branch: string) => Promise<DesktopRepoWorktreeResult>;
  };
  workers: {
    list: () => Promise<WorkerSnapshot[]>;
    listManagedAgentSessions: (roomIdentifier?: string | null) => Promise<DesktopManagedAgentSession[]>;
    onManagedAgentSessionUpdate: (callback: (session: DesktopManagedAgentSession) => void) => () => void;
    startManagedAgent: (input: DesktopManagedAgentStartInput) => Promise<DesktopManagedAgentStartResult>;
    stopManagedAgent: (input?: DesktopManagedAgentStopInput) => Promise<DesktopManagedAgentSession | null>;
    retryManagedAgent: (input: DesktopManagedAgentRetryInput) => Promise<DesktopManagedAgentSession | null>;
    inspectManagedAgent: (
      sessionId?: string | null,
      roomIdentifier?: string | null
    ) => Promise<DesktopManagedAgentInspectResult | null>;
    getManagedAgentChangeSummary: (
      sessionId?: string | null,
      roomIdentifier?: string | null
    ) => Promise<DesktopManagedAgentChangeSummary | null>;
    resolveManagedAgentPermission: (
      input: DesktopManagedAgentPermissionDecisionInput
    ) => Promise<DesktopManagedAgentPermissionDecisionResult>;
    listAgentProviders: () => Promise<DesktopAgentProvider[]>;
    listAgentProviderModels: (
      providerId: DesktopAgentProviderId,
      input?: DesktopAgentProviderPreflightInput
    ) => Promise<DesktopAgentProviderModelsResult>;
    runAgentProviderPreflight: (
      providerId: DesktopAgentProviderId,
      input?: DesktopAgentProviderPreflightInput
    ) => Promise<DesktopAgentProviderPreflight>;
    runAgentProviderSetup: (
      providerId: DesktopAgentProviderId,
      input: DesktopAgentProviderSetupInput
    ) => Promise<DesktopAgentProviderSetupResult>;
  };
  supervisor: {
    getStatus: () => Promise<DesktopSupervisorDaemonStatus>;
    listAgents: (roomIdentifier?: string | null) => Promise<DesktopSupervisorManifestEntry[]>;
    createAgent: (input: DesktopSupervisorCreateInput) => Promise<DesktopSupervisorManifestEntry>;
    resumeOwnershipTransfer: (id: string) => Promise<DesktopSupervisorManifestEntry>;
    setDesiredState: (id: string, desiredState: DesktopSupervisorDesiredState) => Promise<DesktopSupervisorManifestEntry>;
    reconnectAgent: (input: import("./agents.js").DesktopSupervisorReconnectInput) => Promise<DesktopSupervisorManifestEntry>;
    recoverAgentRuntime: (input: import("./agents.js").DesktopSupervisorRuntimeRecoveryInput) => Promise<DesktopSupervisorManifestEntry>;
    retryRoomDelivery: (input: import("./agents.js").DesktopSupervisorRoomDeliveryRetryInput) => Promise<void>;
    restoreAgentConversation: (input: import("./agents.js").DesktopSupervisorConversationRestoreInput) => Promise<void>;
    skipRoomDelivery: (input: import("./agents.js").DesktopSupervisorRoomDeliverySkipInput) => Promise<void>;
    controlTurn: (input: DesktopSupervisorTurnControlInput) => Promise<DesktopSupervisorTurnControlResult>;
    resolveTurnControl: (input: DesktopSupervisorTurnControlResolutionInput) => Promise<DesktopSupervisorManifestEntry>;
    readAttempt: (id: string) => Promise<DesktopSupervisorAttemptDetail>;
    getAgentInspectorDetail: (input: import("./agents.js").DesktopSupervisorAgentInspectorDetailInput) => Promise<import("./agents.js").DesktopSupervisorAgentInspectorDetail>;
    getAgentConfiguration: (input: { entryId: string; daemonGeneration: number }) => Promise<DesktopSupervisorAgentConfiguration>;
    updateAgentConfiguration: (input: DesktopSupervisorAgentConfigurationUpdateInput) => Promise<DesktopSupervisorAgentConfigurationUpdateResult>;
    prepareRoomMove: (input: DesktopSupervisorRoomMovePrepareInput) => Promise<DesktopSupervisorRoomMove>;
    commitRoomMove: (input: DesktopSupervisorRoomMoveOperationInput) => Promise<DesktopSupervisorRoomMove>;
    getRoomMove: (input: DesktopSupervisorRoomMoveOperationInput) => Promise<DesktopSupervisorRoomMove>;
    getCurrentRoomMove: (input: DesktopSupervisorCurrentRoomMoveInput) => Promise<DesktopSupervisorRoomMove | null>;
    retireAgent: (input: { entryId: string; daemonGeneration: number }) => Promise<void>;
    purgeAgent: (input: { entryId: string; daemonGeneration: number }) => Promise<{ outcome: "purged" | "invalid"; error?: string }>;
    onActivity: (callback: (event: { entryId: string; event: import("./agents.js").DesktopSupervisorActivityEvent }) => void) => () => void;
    onState: (callback: (snapshot: import("./agents.js").DesktopSupervisorStateSnapshot) => void) => () => void;
    /** Subscribe to ordered launch facts (task_84). Fold idempotently by `sequence`. */
    onLaunchEvent: (callback: (event: import("./launch-events.js").DesktopLaunchEvent) => void) => () => void;
    /** Replay a launch's facts after `afterSequence` (for modal reopen/restore). */
    getLaunchEvents: (launchId: string, afterSequence?: number | null) => Promise<import("./launch-events.js").DesktopLaunchEvent[]>;
    /** Subscribe to the focused agent's ephemeral live feed (reasoning/text/tool events). */
    onAgentStream: (callback: (batch: import("./agents.js").DesktopAgentStreamBatch) => void) => () => void;
    /** Focus the live feed on one agent, or clear it (null) when the inspector closes. */
    watchAgentStream: (entryId: string | null) => Promise<void>;
  };
  diagnostics: {
    getSnapshot: () => Promise<DiagnosticsSnapshot>;
  };
}
