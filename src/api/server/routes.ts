import type { Express } from "express";

import { upsertAccountRoomRecent } from "../account-room-membership.js";
import {
  assignProjectAdminIfRoomHasNoAdmins,
  concludeFocusRoom,
  getGitHubAppInstallationById,
  getGitHubAppRepositoryByRoomId,
  getGitHubRoomEvents,
  getGitRoomBindingForRoom,
  getGitRoomBindingsForRooms,
  getFocusRoomByKey,
  getProjectById,
  getActiveTaskLeases,
  getRoomSharedArtifactByIdentityKey,
  getRoomSharedArtifacts,
  getTaskById,
  getTaskOwnershipState,
  linkRoomSharedArtifactToTask,
  publishWorkerArtifactFenced,
  updateProjectDisplayName,
  updateTask,
  upsertRoomSharedArtifact,
} from "../db.js";
import { fetchPullRequestUnifiedDiff } from "../github/pull-request-diff.js";
import { toGitHubWebhookId } from "../github/app-sync.js";
import {
  getProjectAccessRoomId,
  isRepoBackedProject,
  isRepoBackedRoomId,
  replyRepoRoomAccessDecision,
  requireGitRoomAdmin as requireAdmin,
  requireGitRoomParticipant as requireParticipant,
  resolveGitHubRoomEntryDecision,
  resolveGitRoomProjectRole as resolveProjectRole,
  resolveRequestProjectRepoAccessRoomName,
  resolveProjectRepoRoomAccessDecision,
  resolveProjectRoomEntryDecision,
  resolveRepoRoomAccessDecision,
} from "../rooms/access.js";
import {
  resolveCanonicalRoomRequestId,
  resolveExistingRoomRequest,
  resolveRoomOrReply,
} from "../rooms/resolution.js";
import { normalizeOptionalString } from "../tasks/coordination-inputs.js";
import {
  parseOptionalAgentPromptKind,
  parseOptionalReplyToMessageId,
  parseOptionalThreadRootMessageId,
  shouldIncludePromptOnlyMessages,
} from "../messages/inputs.js";
import {
  formatFocusRoomConclusionMessage,
  toRoomResponse,
} from "../rooms/formatting.js";
import { requireWorkerRequestAgentIdentity } from "../request/agent-identity.js";
import { resolveRequestAuth } from "../request/auth.js";
import { registerAccountRoomRoutes } from "../routes/account/rooms.js";
import {
  registerAuthRoutes,
  registerGitHubAppCallbackRoute,
} from "../routes/auth/index.js";
import {
  registerGitHubIntegrationRoutes,
  registerGitHubIntegrationSetupRoute,
} from "../routes/github/integration.js";
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookRouteDeps,
} from "../routes/github/webhooks.js";
import { registerHealthRoutes } from "../routes/system/health.js";
import { registerDesktopPushRoutes } from "../routes/desktop-push.js";
import { registerDesktopDownloadRoutes } from "../releases/desktop-download.js";
import {
  registerLegacyProjectRoutes,
  type LegacyProjectRouteDeps,
} from "../routes/legacy/projects.js";
import {
  registerLegacyProjectMessageRoutes,
  type LegacyProjectMessageRouteDeps,
} from "../routes/legacy/messages.js";
import {
  registerLegacyProjectTaskRoutes,
  type LegacyProjectTaskRouteDeps,
} from "../routes/legacy/tasks.js";
import { registerRentalInternalRoutes } from "../routes/rental/internal/index.js";
import {
  registerRentalProviderRoutes,
} from "../routes/rental/provider.js";
import { registerRentalProviderHostRoutes } from "../routes/rental/provider-hosts.js";
import {
  buildInMemoryListingsRateLimiter,
  registerRentalRenterRoutes,
} from "../routes/rental/renter/index.js";
import {
  registerRoomArtifactRoutes,
  type RoomArtifactRouteDeps,
} from "../routes/rooms/artifacts.js";
import {
  registerRoomPullRequestDiffRoutes,
  type RoomPullRequestDiffRouteDeps,
} from "../routes/rooms/pull-request-diff.js";
import {
  registerRoomBoardRoutes,
  type RoomBoardRouteDeps,
} from "../routes/rooms/board.js";
import {
  registerRoomEntryRoutes,
  type RoomEntryRouteDeps,
} from "../routes/rooms/entry.js";
import {
  registerRoomEventRoutes,
  type RoomEventRouteDeps,
} from "../routes/rooms/events.js";
import {
  registerRoomFocusRoutes,
  type RoomFocusRouteDeps,
} from "../routes/rooms/focus.js";
import {
  registerRoomJoinRoutes,
  type RoomJoinRouteDeps,
} from "../routes/rooms/join.js";
import {
  registerRoomMessageRoutes,
  type RoomMessageRouteDeps,
} from "../routes/rooms/messages/index.js";
import {
  registerRoomMetadataRoutes,
  type RoomMetadataRouteDeps,
} from "../routes/rooms/metadata.js";
import {
  registerRoomPresenceRoutes,
  type RoomPresenceRouteDeps,
} from "../routes/rooms/presence/index.js";
import {
  registerRoomReasoningRoutes,
  type RoomReasoningRouteDeps,
} from "../routes/rooms/reasoning.js";
import {
  registerRoomTaskRoutes,
  type RoomTaskRouteDeps,
} from "../routes/rooms/tasks/index.js";
import { registerSupervisorHostGrantRoutes } from "../routes/supervisor-host-grants.js";
import { registerExecutionDelegationRoutes } from "../routes/execution-delegations.js";
import { registerRoomAgentWorkRoutes } from "../routes/rooms/agent-work.js";
import { registerWebRoutes } from "../routes/web/index.js";
import {
  createListing,
  updateListing,
  pauseListing,
  resumeListing,
  listMyListings,
  publicListings,
} from "../rental/listings.js";
import {
  createSession,
  acceptSession,
  declineSession,
  cancelSession,
  getSessionById,
  listProviderRequests,
  listProviderSessions,
} from "../rental/sessions.js";
import { provisionRentalRoomForProvider } from "../rental/room-projection.js";
import { publicRentalProviders } from "../rental/provider-hosts.js";
import { rentalActivityEvents } from "../rental/activity-emitter.js";
import { handleGitHubWebhookEvent } from "../github/webhook-handler.js";
import { ensureTaskGitRoomForActiveWorkLease } from "../github/task-git-room.js";
import {
  artifactEvents,
  agentWorkEvents,
  githubRoomEvents,
  messageEvents,
  reasoningEvents,
  taskEvents,
  emitProjectMessage,
} from "./events.js";
import {
  roomEventBridgeLossEvents,
  setRoomEventBridgeInterestPredicate,
} from "./event-bridge.js";
import { messageInfoEvents } from "./message-info-events.js";
import { createRoomEventBroker, type RoomEventBroker } from "./room-event-broker.js";
import {
  createRoomMessageOverlayBatcher,
  type RoomMessageOverlayBatcher,
} from "./room-message-overlays.js";
import {
  emitTaskLifecycleStatusMessage,
  enforceFocusParentBoardWriteIsolation,
  enforceTaskAdmissionCoordination,
  enforceTaskAdmissionPreconditions,
  enforceTaskCoordinationMutation,
  isTrustedAgentCreator,
  maybeEmitStaleWorkPrompt,
  rememberAgentRoomParticipant,
  rememberHumanRoomParticipant,
  rememberRoomParticipantFromMessage,
  validateOwnerTokenTaskActorKey,
} from "./room-services.js";

let sharedRoomEventBroker: RoomEventBroker | null = null;
let sharedRoomMessageOverlayBatcher: RoomMessageOverlayBatcher | null = null;

function getRoomEventBroker(): RoomEventBroker {
  sharedRoomEventBroker ??= createRoomEventBroker({
    messageEvents,
    taskEvents,
    githubRoomEvents,
    reasoningEvents,
    artifactEvents,
    agentWorkEvents,
    rentalActivityEvents,
    messageInfoEvents,
    bridgeLossEvents: roomEventBridgeLossEvents,
  });
  setRoomEventBridgeInterestPredicate((roomId) => sharedRoomEventBroker?.hasInterest(roomId) ?? false);
  return sharedRoomEventBroker;
}

export function closeApiRouteEventBroker(): void {
  sharedRoomEventBroker?.close();
  sharedRoomEventBroker = null;
  sharedRoomMessageOverlayBatcher?.close();
  sharedRoomMessageOverlayBatcher = null;
  setRoomEventBridgeInterestPredicate(null);
}

export function registerApiRoutes(app: Express): void {
  const roomEventBroker = getRoomEventBroker();
  sharedRoomMessageOverlayBatcher ??= createRoomMessageOverlayBatcher();
  const roomMessageOverlayBatcher = sharedRoomMessageOverlayBatcher;
  const roomEntryRouteDeps = {
    getProjectById,
    resolveExistingRoomRequest,
    getGitRoomBindingForRoom,
    isRepoBackedRoomId,
    resolveGitHubRoomEntryDecision,
    resolveProjectRoomEntryDecision,
  } satisfies RoomEntryRouteDeps;

  registerWebRoutes(app);
  registerDesktopDownloadRoutes(app);

  registerRoomEntryRoutes(app, roomEntryRouteDeps);

  const githubIntegrationRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin,
    requireParticipant,
    getProjectAccessRoomId,
    resolveProjectRepoRoomAccessDecision,
  };

  const legacyProjectRouteDeps = {
    resolveRequestAuth,
    resolveCanonicalRoomRequestId,
    isRepoBackedRoomId,
    isRepoBackedProject,
    resolveRepoRoomAccessDecision,
    resolveProjectRepoRoomAccessDecision,
    replyRepoRoomAccessDecision,
    resolveProjectRole,
    requireAdmin,
    rememberHumanRoomParticipant,
    rememberAccountRoom: upsertAccountRoomRecent,
    getGitRoomBindingForRoom,
  } satisfies LegacyProjectRouteDeps;

  const legacyProjectMessageRouteDeps = {
    roomEventBroker,
    roomMessageOverlayBatcher,
    resolveRequestProjectRepoAccessRoomName,
    resolveCanonicalRoomRequestId,
    requireParticipant,
    parseOptionalAgentPromptKind,
    parseOptionalReplyToMessageId,
    shouldIncludePromptOnlyMessages,
    emitProjectMessage,
    rememberRoomParticipantFromMessage,
    rememberAccountRoom: upsertAccountRoomRecent,
  } satisfies LegacyProjectMessageRouteDeps;

  const legacyProjectTaskRouteDeps = {
    resolveCanonicalRoomRequestId,
    getProjectById,
    requireAdmin,
    requireParticipant,
    normalizeOptionalString,
    enforceTaskAdmissionCoordination,
    isTrustedAgentCreator,
    emitTaskLifecycleStatusMessage,
    validateOwnerTokenTaskActorKey,
    enforceTaskCoordinationMutation,
    enforceFocusParentBoardWriteIsolation: ({ req, targetProject }) =>
      enforceFocusParentBoardWriteIsolation({
        req,
        targetProjectId: targetProject.id,
      }),
    ensureTaskGitRoomForActiveWorkLease,
  } satisfies LegacyProjectTaskRouteDeps;

  const roomMessageRouteDeps = {
    roomEventBroker,
    roomMessageOverlayBatcher,
    resolveRequestProjectRepoAccessRoomName,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
    parseOptionalAgentPromptKind,
    parseOptionalReplyToMessageId,
    parseOptionalThreadRootMessageId,
    shouldIncludePromptOnlyMessages,
    emitProjectMessage,
    rememberRoomParticipantFromMessage,
    rememberAccountRoom: upsertAccountRoomRecent,
  } satisfies RoomMessageRouteDeps;

  const roomPresenceRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin,
    requireParticipant,
    rememberAgentRoomParticipant,
    maybeEmitStaleWorkPrompt,
    emitProjectMessage,
  } satisfies RoomPresenceRouteDeps;

  const roomReasoningRouteDeps = {
    reasoningEvents,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
  } satisfies RoomReasoningRouteDeps;

  const roomFocusRouteDeps = {
    getFocusRoomByKey,
    getTaskById,
    getTaskOwnershipState,
    concludeFocusRoom,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin,
    requireParticipant,
    resolveProjectRole,
    getGitRoomBindingForRoom,
    getGitRoomBindingsForRooms,
    toRoomResponse,
    normalizeOptionalString,
    enforceFocusRoomConclusion: (input) => enforceTaskCoordinationMutation({
      ...input,
      updates: {},
      forcedMutation: { mutation: "focus_room_conclude", leaseKind: "work" },
    }),
    emitProjectMessage,
    formatFocusRoomConclusionMessage,
  } satisfies RoomFocusRouteDeps;

  const roomTaskRouteDeps = {
    taskEvents,
    getTaskById,
    getTaskOwnershipState,
    updateTask,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin,
    requireParticipant,
    resolveProjectRole,
    toRoomResponse,
    normalizeOptionalString,
    enforceTaskAdmissionCoordination,
    isTrustedAgentCreator,
    emitTaskLifecycleStatusMessage,
    validateOwnerTokenTaskActorKey,
    enforceTaskCoordinationMutation,
    enforceFocusParentBoardWriteIsolation: ({ req, targetProject }) =>
      enforceFocusParentBoardWriteIsolation({
        req,
        targetProjectId: targetProject.id,
      }),
    getGitRoomBindingForRoom,
    ensureTaskGitRoomForActiveWorkLease,
    emitProjectMessage,
  } satisfies RoomTaskRouteDeps;

  const roomEventRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
    getProjectAccessRoomId,
  } satisfies RoomEventRouteDeps;

  const roomArtifactRouteDeps = {
    artifactEvents,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
    getActiveTaskLeases,
    getRoomSharedArtifactByIdentityKey,
    getRoomSharedArtifacts,
    linkRoomSharedArtifactToTask,
    publishWorkerArtifactFenced,
    requireWorkerRequestAgentIdentity,
    upsertRoomSharedArtifact,
  } satisfies RoomArtifactRouteDeps;

  const roomPullRequestDiffRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
    getGitHubAppRepositoryByRoomId,
    getGitHubAppInstallationById,
    getGitHubRoomEvents,
    fetchPullRequestUnifiedDiff,
  } satisfies RoomPullRequestDiffRouteDeps;

  const roomBoardRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin,
    requireParticipant,
    normalizeOptionalString,
    emitProjectMessage,
    enforceFocusParentBoardWriteIsolation: ({ req, targetProject }) =>
      enforceFocusParentBoardWriteIsolation({
        req,
        targetProjectId: targetProject.id,
      }),
    enforceTaskCreateBoardIntentAdmission: enforceTaskAdmissionPreconditions,
  } satisfies RoomBoardRouteDeps;

  const roomMetadataRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin,
    updateProjectDisplayName,
    resolveProjectRole,
    getGitRoomBindingForRoom,
    toRoomResponse,
  } satisfies RoomMetadataRouteDeps;

  const roomJoinRouteDeps = {
    resolveCanonicalRoomRequestId,
    isRepoBackedRoomId,
    resolveRepoRoomAccessDecision,
    replyRepoRoomAccessDecision,
    resolveRoomOrReply,
    getProjectAccessRoomId,
    getGitRoomBindingForRoom,
    isRepoBackedProject,
    resolveProjectRepoRoomAccessDecision,
    resolveProjectRole,
    rememberHumanRoomParticipant,
    rememberAccountRoom: upsertAccountRoomRecent,
    assignInitialProjectAdmin: ({ projectId, accountId }) =>
      assignProjectAdminIfRoomHasNoAdmins(projectId, accountId),
    toRoomResponse,
  } satisfies RoomJoinRouteDeps;

  const githubWebhookRouteDeps = {
    toGitHubWebhookId,
    handleGitHubWebhookEvent,
  } satisfies GitHubWebhookRouteDeps;

  registerGitHubIntegrationSetupRoute(app, githubIntegrationRouteDeps);

  registerHealthRoutes(app);

  registerGitHubAppCallbackRoute(app);

  registerGitHubWebhookRoutes(app, githubWebhookRouteDeps);

  registerAuthRoutes(app);
  registerAccountRoomRoutes(app);
  registerDesktopPushRoutes(app);

  registerGitHubIntegrationRoutes(app, githubIntegrationRouteDeps);

  registerLegacyProjectRoutes(app, legacyProjectRouteDeps);

  registerLegacyProjectMessageRoutes(app, legacyProjectMessageRouteDeps);

  registerLegacyProjectTaskRoutes(app, legacyProjectTaskRouteDeps);

  registerRoomJoinRoutes(app, roomJoinRouteDeps);
  registerRoomMessageRoutes(app, roomMessageRouteDeps);
  registerRoomPresenceRoutes(app, roomPresenceRouteDeps);
  registerSupervisorHostGrantRoutes(app, roomPresenceRouteDeps);
  registerExecutionDelegationRoutes(app, roomPresenceRouteDeps);
  registerRoomAgentWorkRoutes(app, roomMessageRouteDeps, roomPresenceRouteDeps);
  registerRoomReasoningRoutes(app, roomReasoningRouteDeps);
  registerRoomFocusRoutes(app, roomFocusRouteDeps);
  registerRoomTaskRoutes(app, roomTaskRouteDeps);
  registerRoomBoardRoutes(app, roomBoardRouteDeps);
  registerRoomEventRoutes(app, roomEventRouteDeps);
  registerRoomArtifactRoutes(app, roomArtifactRouteDeps);
  registerRoomPullRequestDiffRoutes(app, roomPullRequestDiffRouteDeps);
  registerRoomMetadataRoutes(app, roomMetadataRouteDeps);
  registerRentalProviderRoutes(app, {
    createListing,
    updateListing,
    pauseListing,
    resumeListing,
    listMyListings,
    acceptSession,
    declineSession,
    provisionSession: provisionRentalRoomForProvider,
    listProviderRequests,
    listProviderSessions,
  });
  registerRentalProviderHostRoutes(app);
  registerRentalInternalRoutes(app);
  registerRentalRenterRoutes(app, {
    publicListings,
    publicProviders: publicRentalProviders,
    shouldAllowListingsQuery: buildInMemoryListingsRateLimiter(),
    createSession,
    getSessionById,
    cancelSession,
    resolveAuthorizedTargetRoom: async (req, res, roomId) => {
      const canonicalRoomId = await resolveCanonicalRoomRequestId(roomId);
      const room = await resolveRoomOrReply(canonicalRoomId, res);
      if (!room || !(await requireParticipant(req, res, room))) return null;
      return room.id;
    },
  });
}
