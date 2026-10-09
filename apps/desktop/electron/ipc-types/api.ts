export interface DesktopConversationRoutingSettings { enabled: boolean; available: boolean; can_manage: boolean; }
/** "Answer in turns": enabled is the room's sequential reply order; off (parallel) by default. */
export interface DesktopReplyOrderSettings { enabled: boolean; can_manage: boolean; }
/** Reactions of the messages in a requested range, in the shape the shared reaction store reads. */
export interface DesktopMessageReactionsRange {
  /** Only reacted messages appear. */
  reactions: Record<string, MessageReaction[]>;
  /** The emoji the signed-in person reacted with, per message. */
  viewer_reactions?: Record<string, string[]>;
  /** Null when the whole range was read; otherwise the message to continue from. */
  next_first_message_id: string | null;
}
/** The message's reactions after the viewer added or removed one. */
export interface DesktopMessageReactionChange { changed: boolean; reactions: MessageReaction[]; }
/** One page of a room history search, newest first; the shape the shared search controller reads. */
export interface DesktopRoomMessageSearchPage { terms: string[]; messages: DesktopRoomMessage[]; has_more: boolean; next_before: string | null; }
import type { ConversationApi } from "../../../../shared/conversation-contracts.mjs";
import type { DesktopAccountActivityState } from "./account-activity.js";
import type { GitHubRoomChatEventFilter, GitHubRoomChatEventKind, RoomAgentGuidelines } from "../../../../shared/room-settings.mjs";
import type { RoomNotificationPreferenceChange, RoomNotificationPreferenceEntry, RoomNotificationPreferenceList } from "../../../../shared/room-notification-preferences.mjs";
import type { WakeRule, WakeRulePage } from "../../../../shared/wake-rules.mjs";
import type { MessageReaction } from "../../../../shared/message-reactions.mjs";
import type { KnowledgeInput, KnowledgePage, KnowledgeRecord, KnowledgeRevisionInput, KnowledgeType } from "../../../../shared/room-knowledge.mjs";
import type { DesktopAttentionRoom, DesktopNeedsYou } from "./knowledge.js";
import type { DesktopAuthPollResult, DesktopAuthStartResult, DesktopAuthStatus } from "./auth.js";
import type { DesktopNotificationStatus, DesktopNotificationTarget } from "./notifications.js";
import type {
  DesktopProvisionSupervisorGrantInput,
  DesktopSecureStorageStatus,
  DesktopSupervisorGrantMetadata,
} from "./supervisor-grant.js";
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
  DesktopSupervisorAgentConfigurationApplyInput,
  DesktopSupervisorAgentConfigurationApplyResult,
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
  DesktopAgentCommitIdentitySettings,
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
  DesktopLegacyProjectBindingCandidate,
  DesktopProjectBinding,
  DesktopProjectBindingContext,
  DesktopProjectBindingMigrationResult,
  DesktopProjectConnectionResult,
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
  DesktopRoomAgentWorkPollResult,
  DesktopRoomDeliveryRepair,
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
  conversations: ConversationApi;
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
    readWorkspaceReviewPage?: (input: import("../main/workspace-review.js").WorkspaceReviewPageRequest) => Promise<import("../../../../shared/workspace-diff.mjs").WorkspaceDiffPage>;
    closeWorkspaceReview?: (input: { requestId: string }) => Promise<void>;
    readWorkspaceReview?: (input: import("../main/workspace-review.js").WorkspaceReviewRequest) => Promise<import("../main/workspace-review.js").WorkspaceReviewResult>;
    resolveWorkspaceFiles?: (input: { roomId: string; agentKey: string; sourceMessageId: string; paths: string[] }) => Promise<Array<{ path: string; kind: "local" | "github"; url?: string }>>;
    openWorkspaceFile?: (input: { roomId: string; agentKey: string; sourceMessageId: string; paths: string[] }) => Promise<void>;
    getInfo: () => Promise<DesktopAppInfo>;
    openGitHubUrl: (url: string) => Promise<void>;
    openExternalUrl: (url: string) => Promise<void>;
    openCredentialStorage: () => Promise<void>;
    getGitHubPullRequestStats: (url: string) => Promise<DesktopGitHubPullRequestStats | null>;
  };
  maintenance?: {
    getStatus(): Promise<{ held: boolean; ready: boolean }>;
    restart(resume: boolean): Promise<void>;
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
  agentCommitIdentity?: {
    getSettings: () => Promise<DesktopAgentCommitIdentitySettings>;
    setUseHostGitIdentity: (useHostGitIdentity: boolean) => Promise<DesktopAgentCommitIdentitySettings>;
  };
  room: {
    getNeedsYou?: (includeUpdates?: boolean) => Promise<DesktopNeedsYou>;
    /** One room's requests and, when asked, its pending board intents. */
    getNeedsYouRoom?: (room: string, includeBoardIntents: boolean) => Promise<Pick<DesktopAttentionRoom, "records" | "truncated" | "tasks" | "boardIntents">>;
    getKnowledge?: (room: string, type: KnowledgeType) => Promise<KnowledgePage>;
    createKnowledge?: (room: string, type: KnowledgeType, input: KnowledgeInput & { client_id: string }) => Promise<KnowledgeRecord>;
    reviseKnowledge?: (room: string, type: KnowledgeType, id: string, input: KnowledgeRevisionInput) => Promise<KnowledgeRecord>;
    getMemoryHistory?: (room: string, id: string) => Promise<KnowledgePage>;
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
    /** Optional until the preload carrying retained room-work history reloads. */
    pollAgentWork?: (
      roomIdentifier: string,
      afterCursor?: string | null,
    ) => Promise<DesktopRoomAgentWorkPollResult>;
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
    repairStreamDelivery?: (
      roomIdentifier: string,
      repair: DesktopRoomDeliveryRepair,
    ) => Promise<void>;
    stopStream: (roomIdentifier?: string | null) => Promise<void>;
    onStreamEvent: (callback: (event: DesktopRoomStreamEvent) => void) => () => void;
    sendMessage: (
      roomIdentifier: string,
      text: string,
      replyTo?: string | null,
      attachments?: Array<{ upload_id: string }>,
      threadRootId?: string | null,
      clientMessageId?: string | null,
      messageNamespace?: string | null
    ) => Promise<DesktopSendRoomMessageResult>;
    addTask: (roomIdentifier: string, input: DesktopTaskCreateInput) => Promise<DesktopTaskMutationResult>;
    updateTask: (
      roomIdentifier: string,
      taskId: string,
      updates: { title?: string; description?: string; expected_content?: { title?: string; description?: string }; status?: string; assignee?: string | null; pr_url?: string | null }
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
    getConversationRouting: (roomIdentifier: string) => Promise<DesktopConversationRoutingSettings>;
    /** Who is working in each of the account's rooms, and each room's latest message. */
    getAccountActivity?: () => Promise<DesktopAccountActivityState>;
    /** Opens the account's activity stream, or reopens it to watch a changed set of rooms. */
    restartAccountActivity?: () => Promise<void>;
    stopAccountActivity?: () => Promise<void>;
    onAccountActivity?: (callback: (state: DesktopAccountActivityState) => void) => () => void;
    setConversationRouting: (roomIdentifier: string, enabled: boolean) => Promise<DesktopConversationRoutingSettings>;
    getReplyOrder: (roomIdentifier: string) => Promise<DesktopReplyOrderSettings>;
    setReplyOrder: (roomIdentifier: string, enabled: boolean) => Promise<DesktopReplyOrderSettings>;
    /** Cloud rooms only. Optional so a renderer newer than its main process degrades to no reactions. */
    getMessageLinkPreviews?: (roomIdentifier: string, references: import("../../../../shared/message-link-previews.mjs").LinkPreviewReference[]) => Promise<import("../../../../shared/message-link-previews.mjs").MessageLinkPreviewsResponse>;
    getMessagePins?: (roomIdentifier: string) => Promise<import("../../../../shared/message-pins.mjs").MessagePinsResponse>;
    createMessageReminder?: (room: string, message: string, dueAt: string) => Promise<{ reminder: import("./reminders.js").DesktopMessageReminder }>;
    getMessageReminders?: (offset?: number) => Promise<import("./reminders.js").DesktopMessageRemindersPage>;
    deleteMessageReminder?: (id: string) => Promise<{ ok: boolean }>;
    setMessagePin?: (roomIdentifier: string, messageId: string, pinned: boolean) => Promise<import("../../../../shared/message-pins.mjs").MessagePinMutationResponse>;
    reportTyping?: (roomIdentifier: string, input: import("../../../../shared/room-typing.mjs").TypingReport) => Promise<void>;
    getMessageReactions?: (roomIdentifier: string, firstMessageId: string, lastMessageId: string) => Promise<DesktopMessageReactionsRange>;
    setMessageReaction?: (roomIdentifier: string, messageId: string, emoji: string, reacted: boolean) => Promise<DesktopMessageReactionChange>;
    /** Cloud rooms only. Optional so a renderer newer than its main process keeps its in-place find. */
    searchMessages?: (roomIdentifier: string, query: string, beforeMessageId?: string | null) => Promise<DesktopRoomMessageSearchPage>;
    getGitHubEventFilter: (roomIdentifier: string) => Promise<GitHubRoomChatEventFilter>;
    setGitHubEventFilter: (roomIdentifier: string, enabledKinds: GitHubRoomChatEventKind[]) => Promise<GitHubRoomChatEventFilter>;
    getAgentGuidelines: (roomIdentifier: string) => Promise<RoomAgentGuidelines>;
    listNotificationPreferences: () => Promise<RoomNotificationPreferenceList>;
    getNotificationPreference: (identifier: string) => Promise<RoomNotificationPreferenceEntry>;
    setNotificationPreference: (identifier: string, change: RoomNotificationPreferenceChange) => Promise<RoomNotificationPreferenceEntry>;
    setAgentGuidelines: (roomIdentifier: string, guidelines: string) => Promise<RoomAgentGuidelines>;
    getWakeRules: (roomIdentifier: string) => Promise<WakeRulePage>;
    cancelWakeRule: (roomIdentifier: string, ruleId: string) => Promise<WakeRule>;
    restoreWakeRule: (roomIdentifier: string, ruleId: string) => Promise<WakeRule>;
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
    getPullRequestDiff?: (roomIdentifier: string, number: number) => Promise<import("./room.js").DesktopPullRequestDiffResult>;
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
    cancelDeviceFlow: () => Promise<DesktopAuthStatus>;
    openVerification: (url: string) => Promise<void>;
    signOut: () => Promise<DesktopAuthStatus>;
  };
  supervisorGrant: {
    get: () => Promise<DesktopSupervisorGrantMetadata | null>;
    getStorageStatus: () => Promise<DesktopSecureStorageStatus>;
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
    /** `newProjectRoom` is the creation flow: it refuses the home folder and the disk root. */
    openRoom: (rootPath: string, options?: { newProjectRoom?: boolean }) => Promise<DesktopRepoRoomSelection>;
    pickRoom: () => Promise<DesktopRepoRoomSelection>;
    listProjectBindings: () => Promise<DesktopProjectBinding[]>;
    migrateProjectBindings: (
      candidates: DesktopLegacyProjectBindingCandidate[],
    ) => Promise<DesktopProjectBindingMigrationResult>;
    connectProject: (
      context: DesktopProjectBindingContext,
    ) => Promise<DesktopProjectConnectionResult>;
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
    listHostToolRules?: (agentId: string) => Promise<import("../../shared/host-tool-rules.js").HostToolRule[]>;
    revokeHostToolRule?: (input: { agentId: string; ruleId: string; revision: number }) => Promise<void>;
    listHostApprovals?: (roomIdentifier: string) => Promise<import("../../shared/host-approvals.js").DesktopHostApprovalSnapshot>;
    decideHostApproval?: (input: { id: string; decision: import("../../shared/host-approvals.js").HostApprovalSelection }) => Promise<import("../../shared/host-approvals.js").HostApprovalStatus>;
    getStatus: () => Promise<DesktopSupervisorDaemonStatus>;
    getServiceSnapshot?: () => Promise<import("./agents.js").DesktopSupervisorServiceSnapshot>;
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
    setAgentHomeHarness?: (input: import("./agents.js").DesktopSupervisorAgentHomeHarnessInput) => Promise<import("./agents.js").DesktopSupervisorAgentHomeHarnessResult>;
    applyAgentConfiguration: (input: DesktopSupervisorAgentConfigurationApplyInput) => Promise<DesktopSupervisorAgentConfigurationApplyResult>;
    prepareRoomMove: (input: DesktopSupervisorRoomMovePrepareInput) => Promise<DesktopSupervisorRoomMove>;
    commitRoomMove: (input: DesktopSupervisorRoomMoveOperationInput) => Promise<DesktopSupervisorRoomMove>;
    getRoomMove: (input: DesktopSupervisorRoomMoveOperationInput) => Promise<DesktopSupervisorRoomMove>;
    getCurrentRoomMove: (input: DesktopSupervisorCurrentRoomMoveInput) => Promise<DesktopSupervisorRoomMove | null>;
    retireAgent: (input: import("./agents.js").DesktopSupervisorRetirementInput) => Promise<import("./agents.js").DesktopSupervisorRetirementReceipt>;
    getRetirementStatus?: (input: { entryId: string; daemonGeneration: number }) => Promise<import("./agents.js").DesktopSupervisorRetirementStatus>;
    purgeAgent: (input: { entryId: string; daemonGeneration: number }) => Promise<{ outcome: "purged" | "invalid"; error?: string }>;
    onActivity: (callback: (event: { entryId: string; event: import("./agents.js").DesktopSupervisorActivityEvent }) => void) => () => void;
    /** Optional exact-room projection is applied before crossing contextBridge. */
    onState: (callback: (snapshot: import("./agents.js").DesktopSupervisorStateSnapshot) => void, roomIdentifier?: string) => () => void;
    /** Each supervisor state push as Needs you reads agents: not retired, without activity history. */
    onLiveAgents?: (callback: (entries: import("./agents.js").DesktopSupervisorManifestEntry[]) => void) => () => void;
    onRetirement?: (callback: (event: import("./agents.js").DesktopSupervisorRetirementEvent) => void) => () => void;
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
