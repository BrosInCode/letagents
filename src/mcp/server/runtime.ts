// Compatibility facade for MCP server runtime helpers. The implementation lives
// in src/mcp/server/runtime/* so tool modules can import focused responsibilities
// without turning this file back into the runtime god module.
export {
  API_URL,
  ApiError,
  apiCall,
  getAuthorizationHeader,
  getLetagentsToken,
  isMissingRouteError,
  parseApiErrorPayload,
  resolveApiPath,
} from "./runtime/api.js";
export {
  clearAuthenticatedAccountCache,
  getAuthenticatedAccountCache,
  setAuthenticatedAccountCache,
} from "./runtime/auth-cache.js";
export {
  RepoRoomAuthRequiredError,
  maybeHandleRepoRoomAuthRequired,
  startPendingDeviceAuth,
  toRepoRoomAuthRequiredResult,
} from "./runtime/device-auth.js";
export {
  AGENT_INSTANCE_UUID,
  currentAgentIdentity,
  currentAgentIdentityKey,
  detectAgentIdeLabel,
  detectAgentRuntimeLabel,
  ensureAgentIdentity,
  getConversationIdentity,
  getSessionLivenessRegistration,
  resolveOwnerContext,
  setConversationIdentity,
  storeCurrentAgentIdentity,
  toPublicAgentIdentity,
  withAgentIdentity,
  type StoredAccount,
  type StoredAgentIdentityState,
} from "./runtime/identity.js";
export {
  agentSessionCredentials,
  buildAgentDeliveryHeaders,
  ensureLocalWorkerAgentSession,
  getAgentSessionRepoBranch,
  identityFromAgentSession,
  requireWorkerAgentSession,
  resolveAgentSession,
  resolveClientRequestedBase,
  resolveWorkerToolIdentity,
  toPublicAgentSession,
  WORKER_BEARER_AGENT_SESSION_ID,
} from "./runtime/agent-sessions.js";
export {
  appendIncludePromptOnly,
  getLastMessageId,
  normalizeOptionalToolString,
  toAgentReadableMessages,
  withJoinRoomAgentPrompt,
} from "./runtime/messages.js";
export {
  currentRoom,
  attachMcpServer,
  getFallbackProjectId,
  getTargetRoomId,
  rememberRoom,
  shutdownRuntime,
  toPublicRoomResponse,
  toPublicRoomState,
  toPublicStoredRoomSession,
  toRoomState,
  touchCurrentRoom,
  withCanonicalRoomLink,
  type RoomState,
} from "./runtime/room-state.js";
export {
  getRememberedRoomPresence,
  heartbeatRoomPresence,
  syncRoomPresence,
} from "./runtime/presence.js";
export { roomScopedApiCall } from "./runtime/room-api.js";
export {
  bindSupervisedWorkerSession,
  checkpointSupervisedWorkerCursor,
} from "./runtime/supervisor-bridge.js";
export {
  autoJoinFromContext,
  buildJoinResponse,
  createInviteRoom,
  getCurrentLiveSessionPayload,
  joinInviteCode,
  joinNamedRoom,
  joinRoomIdentifier,
  joinRoomIdentifierWithoutImplicitGitRefCreate,
  normalizeJoinSessionMode,
  type JoinSessionMode,
} from "./runtime/rooms.js";

export {
  clearPendingDeviceAuth,
  clearStoredAuth,
  clearStoredAuth as clearStoredAuthorization,
  endStoredAgentSession,
  getCurrentAgentSession,
  getLocalStatePath,
  getPendingDeviceAuth,
  getStoredAgentIdentity,
  getStoredAgentSession,
  getStoredAgentSessionsForRoomIdentity,
  getStoredAuth,
  getStoredCurrentRoom,
  getStoredRoomSession,
  listStoredCodexLiveSessions,
  saveAgentSession,
  setPendingDeviceAuth,
  setStoredAuth,
  setStoredAgentIdentity,
  touchRoomSession,
  addLocalChatMessage,
  addLocalTask,
  claimLocalTaskReviewLease,
  getLatestLocalChatMessages,
  getLocalChatMessages,
  getLocalTask,
  listLocalTasks,
  isLocalChatStorageEnabled,
  isLocalRoomStorageEnabled,
  resolveLocalRoomStorageIdentifiers,
  releaseLocalTaskReviewLease,
  updateLocalTask,
  waitForLocalChatMessages,
  type LocalTask,
  type StoredAgentSessionState,
} from "../local-state.js";
