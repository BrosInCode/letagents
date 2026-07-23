// Compatibility barrel for the API persistence layer.
// Domain implementations live under ./db/.

export type { RoomKind, FocusRoomStatus, Project, RoomAlias, GitRoomBinding, GitRoomSummary, RoomSharedArtifact, RoomSharedArtifactSource, GitHubRepositoryLink, GitHubAppInstallation, GitHubAppRepository, GitHubWebhookDeliveryStatus } from "./db/types.js";
export type { BoardIntent, BoardIntentActionType, BoardIntentConsumptionInput, BoardIntentPayload, BoardIntentStatus, BoardManagerAssignment, BoardManagerCandidate, BoardManagerFailoverMode, BoardManagerMode, BoardManagerRuntimeSource, BoardGovernanceAuditEntry, BoardGovernanceCapabilities, BoardGovernanceSnapshot, BoardGovernanceWarning, RoomBoardSettings } from "./db/types.js";
export { listActiveBoardManagerAssignments, promoteBoardManagerTx, releaseBoardManagerAssignmentTx, listActiveBoardManagerCandidates, recordBoardManagerAssignedEvent, recordBoardManagerReleasedEvent } from "./db/coordination.js";
export { assertBoardIntentAutoApprovalEligibilityTx, BoardIntentAutoApprovalIneligibleError, claimBoardIntentEscalationTx, countRecentAutoApprovedIntents, listEscalationCandidateBoardIntents, markBoardIntentAutoApprovedTx } from "./db/coordination.js";
export type { EscalationCandidateBoardIntent } from "./db/coordination.js";
export { listStalledRoomCandidates, markRoomStallNudgedTx } from "./db/coordination.js";
export type { StalledRoomCandidate } from "./db/coordination.js";
export type { ActiveBoardManagerAssignmentCandidate } from "./db/coordination.js";
export type { GitHubWebhookDelivery, Account, Session, SessionAccount, OwnerToken, OwnerTokenAccount, AuthState, AgentIdentity } from "./db/types.js";
export type { RoomAgentPresence, RoomAgentRegistrationLiveness, RoomAgentLivenessObservation, RoomAgentDeliverySession, RoomAgentSession, RoomAgentSessionBearer, SupervisorHostGrant, CreatedRoomAgentSession, RoomParticipant, RoomActivityActorCount } from "./db/types.js";
export type { ReasoningSession, ReasoningSessionUpdate, Message, MessageReplyReference, MessageThreadParticipant, MessageThreadSummary, MessageAttachment, MessageAttachmentData, MessageAttachmentUpload, TaskStatus } from "./db/types.js";
export type { TaskLeaseKind, TaskLeaseStatus, TaskLockScope, TaskLockReason, CoordinationDecision, Task, TaskStalePromptState, TaskLease, TaskWorkLeaseCreationInput } from "./db/types.js";
export type { TaskLock, StaleTaskPromptMute, CoordinationEvent, TaskOwnershipState, TaskWorkLeaseActionConflict, GitHubRoomEvent, GitHubRoomEventMetadata, TaskGitHubArtifactStatus } from "./db/types.js";
export type { WorkflowEffect, WorkflowEffectKind, WorkflowEffectRow, WorkflowEffectState } from "./db/types.js";
export { createProject, createProjectWithName, getOrCreateProjectByName, getOrCreateCanonicalRoom, getOrCreateGitChildRoom, getGitChildRoom, getProjectByName, getAllProjects, getProjectByCode, getRoomAlias } from "./db/rooms.js";
export { getProjectById, rotateProjectCode, updateProjectDisplayName, createRoomAlias } from "./db/rooms.js";
export { getFocusRoomsForParent, getActiveFocusRoomForTask, getFocusRoomByKey, activateFocusRoom, archiveFocusRoom, claimGitRefFocusRoomLifecycleEvent, concludeFocusRoom, updateFocusRoomSettings, createFocusRoomFromIntent, createFocusRoomForTask } from "./db/focus-rooms.js";
export { getGitHubRepositoryLinkById, upsertGitHubRepositoryLink, migrateGitHubRepositoryCanonicalRoom, upsertGitHubAppInstallation, markGitHubAppInstallationUninstalled, setGitHubAppInstallationSuspended, upsertGitHubAppRepository, markGitHubAppRepositoryRemoved } from "./db/github/index.js";
export { getGitHubAppRepositoryByFullName, getGitHubAppRepositoryByRoomId, getGitHubAppInstallationById, recordGitHubWebhookDelivery, markGitHubWebhookDeliveryProcessed, insertGitHubRoomEvent, updateGitHubRoomEventLinkedTaskId, getGitHubRoomEvents, hasGitHubRoomActivationEventAfter } from "./db/github/index.js";
export { getTasksGitHubArtifactStatus } from "./db/github/index.js";
export { buildManualGitHubRepoRoomBindingInput, ensureGitHubRepoRoomBinding, getGitRoomBindingForRoom, getGitRoomBindingsForRooms, normalizeGitRoomVisibility, upsertGitRoomBinding } from "./db/git-room-bindings.js";
export { buildRoomSharedArtifactIdentityKey, getRoomSharedArtifactByIdentityKey, getRoomSharedArtifacts, linkRoomSharedArtifactToTask, preserveManualRoomSharedArtifactInput, publishWorkerArtifactFenced, syncRoomSharedArtifactsForTask, upsertRoomSharedArtifact } from "./db/room-shared-artifacts.js";
export { addMessage, addMessageWithCreateStatus, getMessages, getLatestMessages, getMessageById, getMessagesBefore, getMessagesAfter, getMessageThread, getMessageThreads, markMessageThreadRead, hydrateMessageReplies, getRoomMessageCountsBySender, getMessageAttachment, createMessageAttachmentUpload } from "./db/messages.js";
export type { MessageCreateTransaction } from "./db/messages.js";
export type { MessageThreadInboxFilter, MessageThreadInboxItem, MessageThreadInboxPage } from "./db/messages.js";
export { getMessageAttachmentUpload, deletePendingMessageAttachmentUpload, hasMessagesFromSender } from "./db/messages.js";
export { upsertRoomAgentPresence, upsertRoomAgentLivenessObservation, heartbeatNativeHarnessTaskLeases, recordNativeHarnessActivity, markRoomAgentDeliveryConnected, markRoomAgentDeliveryHeartbeat, upsertDesktopRoomAgentDeliveryHeartbeat, markRoomAgentDeliveryDisconnected, forceDisconnectRoomAgentDeliverySession, getRoomAgentDeliverySessions, getReachableWorkerDeliverySessionForAgentSession } from "./db/presence.js";
export { setRoomLiveAgentSuppressed, getRoomAgentPresence, getRoomAgentPresenceSnapshot } from "./db/presence.js";
export { listLivenessAnnouncementCandidates, getLivenessAnnouncementCandidate, markAgentOfflineAnnounced, markAgentRecoveryAnnounced, getRoomLiveAgentSuppressionActorLabels } from "./db/presence.js";
export type { LivenessAnnouncementCandidate } from "./db/presence.js";
export { upsertRoomParticipant, getRoomParticipants, getRoomParticipantsForRooms, setRoomParticipantsHidden } from "./db/participants.js";
export { createReasoningSession, getReasoningSessions, getRoomReasoningSessionCountsByActor, getReasoningSessionById, getReasoningSessionUpdates, appendReasoningSessionUpdate, updateReasoningSession } from "./db/reasoning.js";
export { createAuthState, consumeAuthState, upsertAccount, createSession, refreshProviderAccessTokenForAccount, getSessionAccountByToken, deleteSessionByToken, createOwnerToken } from "./db/auth.js";
export { getOwnerTokenAccountByToken, registerAgentIdentity, getAgentIdentityByCanonicalKey, getAgentIdentitiesForOwner, createRoomAgentSession, createFencedRoomAgentSession, createOrRotateSupervisorWorkerSession, SupervisorGrantFenceStaleError, isSupervisorGrantFenceStaleError, SupervisorGrantProvisionConflictError, isSupervisorGrantProvisionConflictError, isActiveRoomAgentSessionStaleForRegistration, isActiveAgentInstanceConflictError, getActiveRoomAgentSessionsForWorkerIdentity, getRoomAgentSessionByCredentials, getSupervisorRoomAgentSession, getRoomAgentSessionBearerByToken, rotateRoomAgentSessionBearer, revokeRoomAgentSessionBearer, getLastEndedWorkerSessionDisplayName, touchRoomAgentSession, createSupervisorHostGrant, getSupervisorHostGrantByToken, getSupervisorHostGrantById, rotateSupervisorHostGrant, advanceSupervisorHostGrantGeneration, revokeSupervisorHostGrant } from "./db/auth.js";
export {
  endRoomAgentSession,
  assignProjectAdmin,
  assignProjectAdminIfRoomHasNoAdmins,
  isProjectAdmin,
} from "./db/auth.js";
export { isValidTransition, getTasksForRooms, createTask, approveTaskCreateBoardIntent, acceptProposedTaskTx, normalizeTaskCreateBoardIntentPayload, getTasks, getOpenTasks, getTaskById, getTaskOwnershipState, findTaskByPrUrl, findTaskBySourceMessageId } from "./db/tasks.js";
export { findTaskByWorkflowArtifactMatches, updateTask, setTaskAssignmentStateForLeaseAction } from "./db/tasks.js";
export { expireStaleTaskLeases, createTaskLease, getActiveTaskLeases, upsertStaleTaskPromptMute, getStaleTaskPromptMutes, clearStaleTaskPromptMute, revokeTaskLease, releaseTaskLease } from "./db/coordination.js";
export { applyTaskWorkLeaseAction, updateTaskLeaseWorkflowRefs, createTaskLock, getActiveTaskLocks, clearTaskLock, createCoordinationEvent } from "./db/coordination.js";
export { rebindTaskLease, assertLeaseEpochCurrentTx, acquireLeaseFenceTx, recordRebindAttestation, LeaseFenceStaleError, isRebindAttestationCause, isUuidShapedExecutionId, REBIND_ATTESTATION_CAUSES } from "./db/coordination.js";
export {
  WorkflowEffectIdempotencyConflictError,
  WorkflowEffectLeaseStaleError,
  claimAmbiguousWorkflowEffect,
  claimFailedWorkflowEffect,
  getWorkflowEffect,
  listReconcilableWorkflowEffects,
  markStalePendingWorkflowEffectAmbiguous,
  markWorkflowEffectAmbiguous,
  markWorkflowEffectFailed,
  markWorkflowEffectSucceeded,
  pruneSettledWorkflowEffects,
  releaseWorkflowEffectLookup,
  reserveWorkflowEffect,
  workflowEffectCorrelationKey,
  workflowEffectRequestFingerprint,
} from "./db/workflow-effects.js";
export type { RebindTaskLeaseInput, RebindTaskLeaseResult, RebindTaskLeaseFailure, LeaseFence, RecordRebindAttestationInput, RecordRebindAttestationResult, RecordRebindAttestationFailure, RebindAttestationCause } from "./db/coordination.js";
export {
  assertConsumeBoardIntentApproval,
  BoardIntentApprovalConsumptionError,
  assignBoardManager,
  approveBoardIntent,
  boardIntentPayloadForLeaseAction,
  boardIntentPayloadForTaskCreate,
  boardIntentPayloadForTaskMutation,
  consumeBoardIntentApproval,
  countBoardIntents,
  createBoardIntent,
  denyBoardIntent,
  expireBoardIntents,
  getActiveBoardManager,
  getBoardIntent,
  getRoomBoardSettings,
  listBoardIntents,
  normalizeBoardManagerMode,
  normalizeBoardManagerRuntimeSource,
  releaseBoardManager,
  setRoomBoardManagerMode,
  shouldRequireBoardIntent,
  verifyBoardIntentApproval,
  getBoardGovernanceSnapshot,
} from "./db/coordination.js";
