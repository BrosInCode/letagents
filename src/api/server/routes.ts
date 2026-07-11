import type { Express } from "express";

import { upsertAccountRoomRecent } from "../account-room-membership.js";
import {
  assignProjectAdminIfRoomHasNoAdmins,
  getGitRoomBindingForRoom,
  getGitRoomBindingsForRooms,
  getProjectById,
  getRoomSharedArtifactByIdentityKey,
  getRoomSharedArtifacts,
  linkRoomSharedArtifactToTask,
  updateProjectDisplayName,
  upsertRoomSharedArtifact,
} from "../db.js";
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
  resolveProjectRepoRoomAccessDecision,
  resolveProjectRoomEntryDecision,
  resolveRepoRoomAccessDecision,
} from "../rooms/access.js";
import {
  resolveCanonicalRoomRequestId,
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
import {
  buildInMemoryListingsRateLimiter,
  registerRentalRenterRoutes,
} from "../routes/rental/renter/index.js";
import {
  registerRoomArtifactRoutes,
  type RoomArtifactRouteDeps,
} from "../routes/rooms/artifacts.js";
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
} from "../rental/sessions.js";
import { provisionRentalRoomForProvider } from "../rental/room-projection.js";
import { handleGitHubWebhookEvent } from "../github/webhook-handler.js";
import { ensureTaskGitRoomForActiveWorkLease } from "../github/task-git-room.js";
import {
  artifactEvents,
  githubRoomEvents,
  messageEvents,
  reasoningEvents,
  taskEvents,
  emitProjectMessage,
} from "./events.js";
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

export function registerApiRoutes(app: Express): void {
  const roomEntryRouteDeps = {
    getProjectById,
    getGitRoomBindingForRoom,
    isRepoBackedRoomId,
    resolveGitHubRoomEntryDecision,
    resolveProjectRoomEntryDecision,
  } satisfies RoomEntryRouteDeps;

  registerWebRoutes(app);

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
    messageEvents,
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
    artifactEvents,
    githubRoomEvents,
    messageEvents,
    taskEvents,
    reasoningEvents,
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
    getRoomSharedArtifactByIdentityKey,
    getRoomSharedArtifacts,
    linkRoomSharedArtifactToTask,
    requireWorkerRequestAgentIdentity,
    upsertRoomSharedArtifact,
  } satisfies RoomArtifactRouteDeps;

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

  registerGitHubIntegrationRoutes(app, githubIntegrationRouteDeps);

  registerLegacyProjectRoutes(app, legacyProjectRouteDeps);

  registerLegacyProjectMessageRoutes(app, legacyProjectMessageRouteDeps);

  registerLegacyProjectTaskRoutes(app, legacyProjectTaskRouteDeps);

  registerRoomJoinRoutes(app, roomJoinRouteDeps);
  registerRoomMessageRoutes(app, roomMessageRouteDeps);
  registerRoomPresenceRoutes(app, roomPresenceRouteDeps);
  registerRoomReasoningRoutes(app, roomReasoningRouteDeps);
  registerRoomFocusRoutes(app, roomFocusRouteDeps);
  registerRoomTaskRoutes(app, roomTaskRouteDeps);
  registerRoomBoardRoutes(app, roomBoardRouteDeps);
  registerRoomEventRoutes(app, roomEventRouteDeps);
  registerRoomArtifactRoutes(app, roomArtifactRouteDeps);
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
  });
  registerRentalInternalRoutes(app);
  registerRentalRenterRoutes(app, {
    publicListings,
    shouldAllowListingsQuery: buildInMemoryListingsRateLimiter(),
    createSession,
    getSessionById,
    cancelSession,
  });
}
