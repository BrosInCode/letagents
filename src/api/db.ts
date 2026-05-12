// Compatibility barrel for the API persistence layer.
// Domain implementations live under ./db/.

export type { RoomKind, FocusRoomStatus, Project, RoomAlias, GitHubRepositoryLink, GitHubAppInstallation, GitHubAppRepository, GitHubWebhookDeliveryStatus } from "./db/types.js";
export type { GitHubWebhookDelivery, Account, Session, SessionAccount, OwnerToken, OwnerTokenAccount, AuthState, AgentIdentity } from "./db/types.js";
export type { RoomAgentPresence, RoomAgentRegistrationLiveness, RoomAgentLivenessObservation, RoomAgentDeliverySession, RoomAgentSession, CreatedRoomAgentSession, RoomParticipant, RoomActivityActorCount } from "./db/types.js";
export type { ReasoningSession, ReasoningSessionUpdate, Message, MessageReplyReference, MessageAttachment, MessageAttachmentData, MessageAttachmentUpload, TaskStatus } from "./db/types.js";
export type { TaskLeaseKind, TaskLeaseStatus, TaskLockScope, TaskLockReason, CoordinationDecision, Task, TaskStalePromptState, TaskLease } from "./db/types.js";
export type { TaskLock, StaleTaskPromptMute, CoordinationEvent, TaskOwnershipState, TaskWorkLeaseActionConflict, GitHubRoomEvent, TaskGitHubArtifactStatus } from "./db/types.js";
export { createProject, createProjectWithName, getOrCreateProjectByName, getOrCreateCanonicalRoom, getProjectByName, getAllProjects, getProjectByCode, getRoomAlias } from "./db/rooms.js";
export { getProjectById, rotateProjectCode, updateProjectDisplayName, createRoomAlias } from "./db/rooms.js";
export { getFocusRoomsForParent, getActiveFocusRoomForTask, getFocusRoomByKey, concludeFocusRoom, updateFocusRoomSettings, createFocusRoomFromIntent, createFocusRoomForTask } from "./db/focus-rooms.js";
export { getGitHubRepositoryLinkById, upsertGitHubRepositoryLink, migrateGitHubRepositoryCanonicalRoom, upsertGitHubAppInstallation, markGitHubAppInstallationUninstalled, setGitHubAppInstallationSuspended, upsertGitHubAppRepository, markGitHubAppRepositoryRemoved } from "./db/github.js";
export { getGitHubAppRepositoryByFullName, getGitHubAppRepositoryByRoomId, getGitHubAppInstallationById, recordGitHubWebhookDelivery, markGitHubWebhookDeliveryProcessed, insertGitHubRoomEvent, updateGitHubRoomEventLinkedTaskId, getGitHubRoomEvents } from "./db/github.js";
export { getTasksGitHubArtifactStatus } from "./db/github.js";
export { addMessage, getMessages, getLatestMessages, getMessagesBefore, getMessagesAfter, getRoomMessageCountsBySender, getMessageAttachment, createMessageAttachmentUpload } from "./db/messages.js";
export { getMessageAttachmentUpload, deletePendingMessageAttachmentUpload, hasMessagesFromSender } from "./db/messages.js";
export { upsertRoomAgentPresence, upsertRoomAgentLivenessObservation, markRoomAgentDeliveryConnected, markRoomAgentDeliveryHeartbeat, markRoomAgentDeliveryDisconnected, forceDisconnectRoomAgentDeliverySession, getRoomAgentDeliverySessions, getReachableWorkerDeliverySessionForAgentSession } from "./db/presence.js";
export { setRoomLiveAgentSuppressed, getRoomAgentPresence, getRoomAgentPresenceSnapshot } from "./db/presence.js";
export { upsertRoomParticipant, getRoomParticipants, getRoomParticipantsForRooms, setRoomParticipantsHidden } from "./db/participants.js";
export { createReasoningSession, getReasoningSessions, getRoomReasoningSessionCountsByActor, getReasoningSessionById, getReasoningSessionUpdates, appendReasoningSessionUpdate, updateReasoningSession } from "./db/reasoning.js";
export { createAuthState, consumeAuthState, upsertAccount, createSession, refreshProviderAccessTokenForAccount, getSessionAccountByToken, deleteSessionByToken, createOwnerToken } from "./db/auth.js";
export { getOwnerTokenAccountByToken, registerAgentIdentity, getAgentIdentityByCanonicalKey, getAgentIdentitiesForOwner, createRoomAgentSession, getActiveRoomAgentSessionsForWorkerIdentity, getRoomAgentSessionByCredentials, touchRoomAgentSession } from "./db/auth.js";
export { endRoomAgentSession, assignProjectAdmin, isProjectAdmin } from "./db/auth.js";
export { isValidTransition, getTasksForRooms, createTask, getTasks, getOpenTasks, getTaskById, getTaskOwnershipState, findTaskByPrUrl } from "./db/tasks.js";
export { findTaskByWorkflowArtifactMatches, updateTask, setTaskAssignmentStateForLeaseAction } from "./db/tasks.js";
export { expireStaleTaskLeases, createTaskLease, getActiveTaskLeases, upsertStaleTaskPromptMute, getStaleTaskPromptMutes, clearStaleTaskPromptMute, revokeTaskLease, releaseTaskLease } from "./db/coordination.js";
export { applyTaskWorkLeaseAction, updateTaskLeaseWorkflowRefs, createTaskLock, getActiveTaskLocks, clearTaskLock, createCoordinationEvent } from "./db/coordination.js";
