import type { Express } from "express";

import { upsertAccountRoomRecent } from "../account-room-membership.js";
import { getProjectById } from "../db.js";
import { toGitHubWebhookId } from "../github/app-sync.js";
import {
  getProjectAccessRoomId,
  isRepoBackedProject,
  isRepoBackedRoomId,
  replyRepoRoomAccessDecision,
  requireAdmin,
  requireParticipant,
  resolveGitHubRoomEntryDecision,
  resolveProjectRole,
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
  shouldIncludePromptOnlyMessages,
} from "../messages/inputs.js";
import {
  formatFocusRoomConclusionMessage,
  toRoomResponse,
} from "../rooms/formatting.js";
import { resolveRequestAuth } from "../request/auth.js";
import { registerAccountRoomRoutes } from "../routes/account-rooms.js";
import {
  registerAuthRoutes,
  registerGitHubAppCallbackRoute,
} from "../routes/auth.js";
import {
  registerGitHubIntegrationRoutes,
  registerGitHubIntegrationSetupRoute,
} from "../routes/github-integration.js";
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookRouteDeps,
} from "../routes/github-webhooks.js";
import { registerHealthRoutes } from "../routes/health.js";
import {
  registerLegacyProjectRoutes,
  type LegacyProjectRouteDeps,
} from "../routes/legacy-projects.js";
import {
  registerLegacyProjectMessageRoutes,
  type LegacyProjectMessageRouteDeps,
} from "../routes/legacy-project-messages.js";
import {
  registerLegacyProjectTaskRoutes,
  type LegacyProjectTaskRouteDeps,
} from "../routes/legacy-project-tasks.js";
import { registerRentalInternalRoutes } from "../routes/rental-internal.js";
import {
  registerRentalProviderRoutes,
} from "../routes/rental-provider.js";
import {
  buildInMemoryListingsRateLimiter,
  registerRentalRenterRoutes,
} from "../routes/rental-renter.js";
import {
  registerRoomEntryRoutes,
  type RoomEntryRouteDeps,
} from "../routes/room-entry.js";
import {
  registerRoomEventRoutes,
  type RoomEventRouteDeps,
} from "../routes/room-events.js";
import {
  registerRoomFocusRoutes,
  type RoomFocusRouteDeps,
} from "../routes/room-focus.js";
import {
  registerRoomJoinRoutes,
  type RoomJoinRouteDeps,
} from "../routes/room-join.js";
import {
  registerRoomMessageRoutes,
  type RoomMessageRouteDeps,
} from "../routes/room-messages.js";
import {
  registerRoomMetadataRoutes,
  type RoomMetadataRouteDeps,
} from "../routes/room-metadata.js";
import {
  registerRoomPresenceRoutes,
  type RoomPresenceRouteDeps,
} from "../routes/room-presence.js";
import {
  registerRoomReasoningRoutes,
  type RoomReasoningRouteDeps,
} from "../routes/room-reasoning.js";
import {
  registerRoomTaskRoutes,
  type RoomTaskRouteDeps,
} from "../routes/room-tasks.js";
import { registerWebRoutes } from "../routes/web.js";
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
import {
  messageEvents,
  reasoningEvents,
  taskEvents,
  emitProjectMessage,
} from "./events.js";
import {
  emitTaskLifecycleStatusMessage,
  enforceFocusParentBoardWriteIsolation,
  enforceTaskAdmissionCoordination,
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
    isRepoBackedRoomId,
    resolveGitHubRoomEntryDecision,
  } satisfies RoomEntryRouteDeps;

  registerWebRoutes(app);

  registerRoomEntryRoutes(app, roomEntryRouteDeps);

  const githubIntegrationRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin,
    requireParticipant,
    getProjectAccessRoomId,
    isRepoBackedProject,
  };

  const legacyProjectRouteDeps = {
    resolveRequestAuth,
    resolveCanonicalRoomRequestId,
    isRepoBackedRoomId,
    isRepoBackedProject,
    resolveRepoRoomAccessDecision,
    replyRepoRoomAccessDecision,
    resolveProjectRole,
    requireAdmin,
    rememberHumanRoomParticipant,
    rememberAccountRoom: upsertAccountRoomRecent,
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
  } satisfies LegacyProjectTaskRouteDeps;

  const roomMessageRouteDeps = {
    messageEvents,
    taskEvents,
    reasoningEvents,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
    parseOptionalAgentPromptKind,
    parseOptionalReplyToMessageId,
    shouldIncludePromptOnlyMessages,
    emitProjectMessage,
    rememberRoomParticipantFromMessage,
  } satisfies RoomMessageRouteDeps;

  const roomPresenceRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin,
    requireParticipant,
    rememberAgentRoomParticipant,
    maybeEmitStaleWorkPrompt,
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
    requireParticipant,
    resolveProjectRole,
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
    emitProjectMessage,
  } satisfies RoomTaskRouteDeps;

  const roomEventRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
    getProjectAccessRoomId,
  } satisfies RoomEventRouteDeps;

  const roomMetadataRouteDeps = {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin,
    resolveProjectRole,
    toRoomResponse,
  } satisfies RoomMetadataRouteDeps;

  const roomJoinRouteDeps = {
    resolveCanonicalRoomRequestId,
    isRepoBackedRoomId,
    resolveRepoRoomAccessDecision,
    replyRepoRoomAccessDecision,
    resolveRoomOrReply,
    getProjectAccessRoomId,
    isRepoBackedProject,
    resolveProjectRole,
    rememberHumanRoomParticipant,
    rememberAccountRoom: upsertAccountRoomRecent,
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
  registerRoomEventRoutes(app, roomEventRouteDeps);
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
