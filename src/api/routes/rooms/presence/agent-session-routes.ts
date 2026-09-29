import type { Express } from "express";
import {
  closeRoomAgentProcessConnection,
  getDurableRoomWorkerSessions,
  getRoomWorkerNameHolders,
  isEndedRoomAgentSessionCredential,
  openRoomAgentProcessConnection,
  recordRoomAgentProcessExit,
  refreshRoomAgentProcessConnection,
} from "../../../db/auth/room-agent-sessions.js";
import { claimRoomParticipantOwner, getParticipantOwnersProvenByMessages } from "../../../db/participants.js";
import { db } from "../../../db/client.js";
import { getSessionConnections } from "../../../db/messages/session-connections.js";
import { isMcpWorkerId, isMcpConnectionToken } from "../../../../shared/mcp-worker.js";

import {
  createFencedRoomAgentSession,
  endRoomAgentSession,
  getActiveRoomAgentSessionsForWorkerIdentity,
  getAgentIdentityByCanonicalKey,
  getLastEndedWorkerSessionDisplayName,
  getRoomAgentSessionByCredentials,
  getRoomParticipants,
  isActiveAgentInstanceConflictError,
  isActiveRoomAgentSessionStaleForRegistration,
  recordNativeHarnessActivity,
  pauseDesktopRoomAgentDelivery,
  isStaleDesktopRoomAgentDeliverySignalError,
  upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat,
  upsertRoomAgentPresence,
} from "../../../db.js";
import {
  respondWithInternalError,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import { disconnectRoomAgentDeliverySession } from "../../../rooms/agent-delivery.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import {
  requireWorkerRequestAgentIdentity,
  type ResolvedRequestAgentIdentity,
} from "../../../request/agent-identity.js";
import { buildAgentActorLabel, parseAgentActorLabel } from "../../../../shared/agent-identity.js";
import { pickLocalCodename } from "../../../../shared/codenames.js";
import { isMessageSenderWithinBounds } from "../../../../../shared/message-contracts.mjs";
import {
  AGENT_PROCESS_CONNECTION_REFRESH_MS,
  normalizeAgentPresenceStatus,
  normalizeRoomAgentSessionKind,
} from "../../../../shared/agent-presence.js";
import {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../../../../shared/request-headers.js";
import { openSseConnection } from "../../../http/sse.js";
import {
  announceAgentSessionEnded,
  holdAgentProcessConnection,
} from "../../../rooms/agent-process-connections.js";
import {
  isActiveWorkerActorLabelConflict,
  isLockTimeout,
  normalizeOptionalText,
  normalizeRegistrationLiveness,
  normalizeRuntime,
} from "./helpers.js";
import type { RoomPresenceRouteDeps } from "./types.js";
import {
  agentDisplayNameKey,
  allocateAgentDisplayName,
  isNameHeldByAnotherAgent,
  selectReleasableNameHolders,
} from "../../../rooms/agent-display-name-allocation.js";

export function desktopManagedPausePresence(input: {
  availability?: "failure" | "room_closed";
  statusText?: string;
}): { status: "idle" | "blocked"; statusText: string } {
  const roomClosed = input.availability === "room_closed";
  return {
    status: roomClosed ? "idle" : "blocked",
    statusText: input.statusText?.slice(0, 240) || (roomClosed
      ? "Room not open on the managing desktop"
      : "Needs attention"),
  };
}

/**
 * True when `label` is exactly `base` plus one or more trailing space-separated
 * pure-digit groups — i.e. the shape the collision allocator used to produce
 * (`${base} ${offset}`), possibly compounded by the historical bug. The
 * allocator no longer mints these, but clients still replay stored ones. Used to
 * validate that a trusted base signal actually corresponds to the requested
 * label before reducing to it.
 */
export function isNumericSuffixExtension(label: string, base: string): boolean {
  const trimmedLabel = label.trim();
  const trimmedBase = base.trim();
  if (!trimmedBase || !trimmedLabel.startsWith(`${trimmedBase} `)) return false;
  const suffix = trimmedLabel.slice(trimmedBase.length).trim();
  return suffix.length > 0 && suffix.split(/\s+/).every((part) => /^\d+$/.test(part));
}

/**
 * Resolve the canonical base to normalize a replayed display name against,
 * using an EXPLICIT trusted client signal — never numeric-shape/history
 * inference. `trustedBaseSignal` is the stable base the client declares for its
 * canonical identity (`requested_base_display_name`). It is honored only when
 * the requested label IS that base or that base plus a numeric collision
 * suffix, so a compounded "MistyMorrow 2 1 1 1" reduces to a client-declared
 * "MistyMorrow" while a deliberately-requested "Agent 47" (declared base
 * "Agent 47", or no signal) is preserved. With no trusted proof the label is
 * preserved verbatim (fail closed) — the server never guesses intent.
 */
export function resolveReplayCanonicalBase(
  requestedDisplayName: string,
  trustedBaseSignal: string | null | undefined,
): string {
  const requested = requestedDisplayName.trim();
  const trusted = (trustedBaseSignal ?? "").trim();
  if (trusted && (requested === trusted || isNumericSuffixExtension(requested, trusted))) {
    return trusted;
  }
  return requested;
}

export function normalizeReplayedAgentDisplayName(
  requestedDisplayName: string,
  canonicalDisplayName: string
): string {
  const canonical = canonicalDisplayName.trim();
  const requested = requestedDisplayName.trim();
  if (!canonical || !requested.startsWith(`${canonical} `)) return requested;

  const suffix = requested.slice(canonical.length).trim();
  return suffix && suffix.split(/\s+/).every((part) => /^\d+$/.test(part))
    ? canonical
    : requested;
}

export function registerAgentSessionRoutes(
  app: Express,
  deps: RoomPresenceRouteDeps
): void {
  const failureMessages = {
    quota_exhausted: "The provider usage limit was reached. Change the model or quota settings, then retry.",
    authentication_required: "The provider needs authentication. Sign in again, then retry.",
    model_unavailable: "The selected model is unavailable. Choose another model, then retry.",
    configuration_error: "The provider configuration needs attention. Update it, then retry.",
    provider_error: "The provider could not complete this turn. Open the agent controls for details.",
  } as const;

  app.post(/^\/rooms\/(.+)\/agent-sessions$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;
    if (!req.sessionAccount?.account_id) {
      res.status(401).json({ error: "Agent session registration requires authenticated owner context." });
      return;
    }

    const {
      actor_key,
      actor_label,
      display_name,
      requested_base_display_name,
      connection_token,
      ide_label,
      agent_instance_id,
      session_kind,
      runtime,
      repo_branch,
      registration_liveness,
      process_host_id,
      replace_agent_session_id,
      replace_agent_session_token,
    } = req.body as {
      actor_key?: string;
      actor_label?: string;
      display_name?: string;
      requested_base_display_name?: string | null;
      connection_token?: string;
      ide_label?: string;
      agent_instance_id?: string | null;
      session_kind?: string;
      runtime?: string;
      repo_branch?: string | null;
      registration_liveness?: unknown;
      process_host_id?: unknown;
      replace_agent_session_id?: string | null;
      replace_agent_session_token?: string | null;
    };

    const actorKey = typeof actor_key === "string" ? actor_key.trim() : "";
    if (!actorKey) {
      res.status(400).json({ error: "actor_key is required" });
      return;
    }

    try {
      const agent = await getAgentIdentityByCanonicalKey(actorKey);
      if (!agent || agent.owner_account_id !== req.sessionAccount.account_id) {
        res.status(403).json({ error: "actor_key is not owned by this account" });
        return;
      }

      const parsedActorLabel = parseAgentActorLabel(actor_label);
      const resolvedIdeLabel = (
        typeof ide_label === "string" && ide_label.trim()
          ? ide_label.trim()
          : parsedActorLabel?.ide_label ?? "Agent"
      );
      const requestedDisplayName = typeof display_name === "string" ? display_name.trim() : "";
      const genericKeywords = new Set(["antigravity", "codex", "agent", "worker", "local", "claude", "cursor", "cline", "roo"]);
      resolvedIdeLabel.toLowerCase().split(/[\s_-]+/).forEach((token) => {
        if (token) genericKeywords.add(token);
      });
      const requestedTokens = requestedDisplayName.toLowerCase().split(/[\s_-]+/).filter((token) => token.length > 0);
      const isGenericName = !requestedDisplayName || requestedTokens.every((token) => genericKeywords.has(token));

      const requestedSessionKind = normalizeRoomAgentSessionKind(session_kind || "worker");
      const normalizedAgentInstanceId = typeof agent_instance_id === "string" ? agent_instance_id.trim() || null : null;
      const durableWorker = isMcpWorkerId(normalizedAgentInstanceId);
      if ((durableWorker && requestedSessionKind !== "worker") || durableWorker !== Boolean(connection_token)
        || (connection_token !== undefined && !isMcpConnectionToken(connection_token))) {
        res.status(400).json({ error: "A durable worker requires a valid prepared connection credential." });
        return;
      }
      const normalizedRegistrationLiveness = normalizeRegistrationLiveness(registration_liveness);
      const processHostId = typeof process_host_id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(process_host_id)
        ? process_host_id
        : null;
      const replacementSessionId = typeof replace_agent_session_id === "string"
        ? replace_agent_session_id.trim()
        : "";
      const replacementSessionToken = typeof replace_agent_session_token === "string"
        ? replace_agent_session_token.trim()
        : "";
      if (
        Boolean(replacementSessionId) !== Boolean(replacementSessionToken)
        || replacementSessionId.length > 240
        || replacementSessionToken.length > 512
      ) {
        res.status(400).json({
          error: "replace_agent_session_id and replace_agent_session_token must be supplied together.",
          code: "invalid_agent_session_replacement_proof",
        });
        return;
      }
      const [activeParticipants, activeSessionsForIdentity, durableWorkers, workerNameHolders] = await Promise.all([
        getRoomParticipants(project.id, { limit: 200 }),
        requestedSessionKind === "worker"
          ? getActiveRoomAgentSessionsForWorkerIdentity({
              room_id: project.id,
              agent_key: agent.canonical_key,
            })
          : Promise.resolve([]),
        getDurableRoomWorkerSessions(project.id),
        getRoomWorkerNameHolders(project.id),
      ]);
      const replaceableSessionIds = new Set(
        activeSessionsForIdentity
          .filter((session) => normalizedAgentInstanceId
            && session.agent_instance_id === normalizedAgentInstanceId
            && (durableWorker || session.session_id === replacementSessionId
              || isActiveRoomAgentSessionStaleForRegistration({
              active_session: session,
            })))
          .map((session) => session.session_id),
      );
      const conflictingSameInstance = activeSessionsForIdentity.find((session) =>
        normalizedAgentInstanceId
          && session.agent_instance_id === normalizedAgentInstanceId
          && !replaceableSessionIds.has(session.session_id)
      );
      if (conflictingSameInstance && !durableWorker) {
        res.status(409).json({
          error: "This exact agent instance is already active on another live transport.",
          code: "agent_instance_already_active",
          active_session_id: conflictingSameInstance.session_id,
        });
        return;
      }
      const allocationSessions = activeSessionsForIdentity.filter(
        (session) => !replaceableSessionIds.has(session.session_id),
      );

      // Reduce a replayed, already-decorated label to its base ONLY from the
      // client's explicit trusted base signal (`requested_base_display_name`),
      // never from numeric shape or name history. Absent a valid signal the
      // label is preserved verbatim (fail closed), so a deliberate
      // numeric-ending name is never demoted and legacy accumulation is not
      // "guessed" away.
      const trustedRequestedBase = typeof requested_base_display_name === "string"
        ? requested_base_display_name.trim()
        : "";
      const canonicalDisplayName = resolveReplayCanonicalBase(requestedDisplayName, trustedRequestedBase);
      const normalizedRequestedDisplayName = normalizeReplayedAgentDisplayName(
        requestedDisplayName,
        canonicalDisplayName
      );

      let baseDisplayName = isGenericName
        ? pickLocalCodename(agent.canonical_key).display_name
        : (normalizedRequestedDisplayName || canonicalDisplayName);
      // A name held by a session whose process is gone passes to a
      // registration by the same owner that has no session of its own. A
      // process that restarts leaves its session behind, and an agent that
      // registers afresh leaves its registration behind; nothing else ends
      // either, so without this each would refuse the agent its own name for
      // ever.
      const ownCurrentSession = normalizedAgentInstanceId
        ? activeSessionsForIdentity.find((session) => session.agent_instance_id === normalizedAgentInstanceId) ?? null
        : null;
      const registersAfresh = requestedSessionKind === "worker"
        && Boolean(normalizedAgentInstanceId)
        && !ownCurrentSession
        && !durableWorkers.some((session) => session.agent_instance_id === normalizedAgentInstanceId
          && session.agent_key === agent.canonical_key);
      // A holder that has already ended has nothing left to end, so its
      // reservation lapses for any registration. One that is still live can
      // only be ended by a registration with no session of its own.
      const { connected: deliveryConnected } = await getSessionConnections(
        db, project.id, workerNameHolders.filter((holder) => !holder.ended_at).map((holder) => holder.session_id));
      const workerNameHoldersWithConnections = workerNameHolders.map((holder) => ({
        ...holder, delivery_connected: deliveryConnected.has(holder.session_id),
      }));
      const releasableHolders = requestedSessionKind === "worker" && normalizedAgentInstanceId
        ? selectReleasableNameHolders({
            display_name: baseDisplayName,
            owner_account_id: req.sessionAccount.account_id,
            agent_key: agent.canonical_key,
            agent_instance_id: normalizedAgentInstanceId,
            process_host_id: processHostId,
            holders: workerNameHoldersWithConnections,
            now_ms: Date.now(),
          }).filter((holder) => holder.ended_at !== null || registersAfresh)
        : [];
      const releasedSessionIds = new Set(releasableHolders.map((holder) => holder.session_id));
      const releasedAgentKeys = new Set(releasableHolders
        .filter((holder) => holder.agent_key !== agent.canonical_key)
        .map((holder) => holder.agent_key));
      const heldAllocationSessions = allocationSessions.filter(
        (session) => !releasedSessionIds.has(session.session_id));
      const heldDurableWorkers = durableWorkers.filter(
        (session) => !releasedSessionIds.has(session.session_id));
      const heldWorkerNameHolders = workerNameHolders.filter(
        (holder) => !releasedSessionIds.has(holder.session_id));
      // An agent's own history never holds a name against it. Holding an
      // agent's past names against it is what renamed it on every reconnect:
      // each name it was given became one more name it could not have.
      //
      // A row is this identity's own when it carries its key. Rows written
      // before messages recorded their sender's key carry none, so the row
      // for the requested name is settled by the room's messages instead: it
      // is this identity's when every authenticated message sent under that
      // label came from this key. The proven owner is then recorded, so the
      // question is asked once.
      const provenOwnParticipantKeys = new Set<string>();
      if (requestedSessionKind === "worker") {
        const unownedNamesakes = activeParticipants.filter((participant) =>
          participant.kind === "agent" && !participant.agent_key && participant.actor_label
          && participant.display_name === baseDisplayName);
        if (unownedNamesakes.length > 0) {
          const provenOwners = await getParticipantOwnersProvenByMessages({
            room_id: project.id,
            actor_labels: unownedNamesakes.map((participant) => participant.actor_label!),
          });
          for (const participant of unownedNamesakes) {
            const owner = provenOwners.get(participant.actor_label!);
            if (!owner) continue;
            if (owner === agent.canonical_key || releasedAgentKeys.has(owner)) {
              provenOwnParticipantKeys.add(participant.participant_key);
            }
            // Bookkeeping only: the registration does not depend on it.
            await claimRoomParticipantOwner({
              room_id: project.id, participant_key: participant.participant_key, agent_key: owner,
            }).catch((error) => {
              console.error(`[agent sessions] failed to record participant owner for ${project.id}`, error);
            });
          }
        }
      }
      const isOwnParticipant = (participant: (typeof activeParticipants)[number]): boolean =>
        participant.kind === "agent" && (participant.agent_key === agent.canonical_key
          // History of an agent that released the name holds it no longer.
          || (participant.agent_key !== null && releasedAgentKeys.has(participant.agent_key))
          || provenOwnParticipantKeys.has(participant.participant_key));
      const holdsOwnHistory = requestedSessionKind !== "worker";
      const usedDisplayNames = new Set([
        ...activeParticipants.filter((participant) => holdsOwnHistory || !isOwnParticipant(participant))
          .map((participant) => participant.display_name),
        ...heldAllocationSessions.map((session) => session.display_name),
        ...heldDurableWorkers.filter((session) => session.agent_instance_id !== normalizedAgentInstanceId)
          .map((session) => session.display_name),
      ]);

      // Participant rows are durable room history, not proof that a label is
      // still live. A restarted worker using the same canonical identity may
      // reclaim its base label once no active session for that identity holds
      // it. Never reclaim a label that belongs to a human or another agent:
      // genuinely concurrent/same-name peers still need disambiguation.
      if (requestedSessionKind === "worker") {
        const baseHeldByThisIdentity = heldAllocationSessions.some(
          (session) => session.display_name === baseDisplayName
        ) || heldDurableWorkers.some((session) => session.display_name === baseDisplayName
          && session.agent_instance_id !== normalizedAgentInstanceId);
        const baseBelongsToAnotherParticipant = activeParticipants.some(
          (participant) => participant.display_name === baseDisplayName && !isOwnParticipant(participant)
        );
        if (!baseHeldByThisIdentity && !baseBelongsToAnotherParticipant) {
          usedDisplayNames.delete(baseDisplayName);
        }
      }

      // Burst workers resume the name their instance used last time instead
      // of minting a numbered variant: the persistent participant record
      // keeps old names in usedDisplayNames forever, but a name whose worker
      // session ENDED is free again (the active-worker unique index only
      // guards live sessions; a genuine live collision still falls through
      // to the conflict-retry loop below).
      const priorInstanceId = typeof agent_instance_id === "string" ? agent_instance_id.trim() || null : null;
      if (requestedSessionKind === "worker" && priorInstanceId && !durableWorker) {
        const resumableName = await getLastEndedWorkerSessionDisplayName({
          room_id: project.id,
          agent_key: agent.canonical_key,
          agent_instance_id: priorInstanceId,
        });
        // Resume only when the caller expressed no contrary intent: a
        // generic/absent requested name, or an explicit request for the
        // same name. An explicit DIFFERENT name is a deliberate rename and
        // wins over resumption.
        if (
          resumableName
          && (isGenericName || resumableName === baseDisplayName)
          && !heldAllocationSessions.some((session) => session.display_name === resumableName)
        ) {
          usedDisplayNames.delete(resumableName);
          baseDisplayName = resumableName;
        }
      }
      const durablePredecessor = durableWorker
        ? heldDurableWorkers.find((session) => session.agent_instance_id === normalizedAgentInstanceId
          && session.agent_key === agent.canonical_key)
        : null;
      if (durablePredecessor) {
        baseDisplayName = durablePredecessor.display_name;
        usedDisplayNames.delete(baseDisplayName);
      }
      // Room history is matched exactly, as it always was: it records what a
      // participant was once called and cannot make a mention ambiguous. An
      // agent of another identity that answers to a name now is matched the
      // way mention routing matches it, so no spelling of that name is free.
      const ownSessions = heldWorkerNameHolders.filter((holder) =>
        holder.agent_key === agent.canonical_key && !holder.ended_at);
      const isHeld = (displayName: string): boolean => usedDisplayNames.has(displayName)
        || isNameHeldByAnotherAgent({
          display_name: displayName,
          agent_key: agent.canonical_key,
          own_sessions: ownSessions,
          holders: heldWorkerNameHolders,
        });
      // A session that registers again keeps the name it is living under
      // when the name it asks for is held, rather than being moved again.
      // Room history never contests the name a session is living under; only
      // another agent that answers to it now can.
      if (ownCurrentSession && !durableWorker) {
        const heldByAnotherAgent = (displayName: string): boolean => isNameHeldByAnotherAgent({
          display_name: displayName,
          agent_key: agent.canonical_key,
          own_sessions: ownSessions,
          holders: heldWorkerNameHolders,
        });
        if (agentDisplayNameKey(ownCurrentSession.display_name) === agentDisplayNameKey(baseDisplayName)) {
          if (!heldByAnotherAgent(baseDisplayName)) usedDisplayNames.delete(baseDisplayName);
        } else if (isHeld(baseDisplayName) && !heldByAnotherAgent(ownCurrentSession.display_name)) {
          usedDisplayNames.delete(ownCurrentSession.display_name);
          baseDisplayName = ownCurrentSession.display_name;
        }
      }

      let offset = 0;
      const normalizedRepoBranch = normalizeOptionalText(repo_branch);
      const maxRegistrationAttempts = 25;
      for (let attempt = 0; attempt < maxRegistrationAttempts; attempt += 1) {
        // A held name receives its own codename, never a numbered variant.
        const allocated = allocateAgentDisplayName({
          base_display_name: baseDisplayName,
          agent_key: agent.canonical_key,
          is_held: isHeld,
          from_offset: offset,
        });
        if (!allocated) break;
        offset = allocated.collision_offset;
        const sessionDisplayName = allocated.display_name;
        const actorLabel = buildAgentActorLabel({
          display_name: sessionDisplayName,
          owner_label: agent.owner_label,
          ide_label: resolvedIdeLabel,
        });
        // Only holders of the name actually being taken are ended, and only
        // those still live: an offline durable holder has nothing to end.
        const takenKey = agentDisplayNameKey(sessionDisplayName);
        const takeoverSessionIds = releasableHolders
          .filter((holder) => !holder.ended_at && agentDisplayNameKey(holder.display_name) === takenKey)
          .map((holder) => holder.session_id);
        if (
          !isMessageSenderWithinBounds(actorLabel)
          || !isMessageSenderWithinBounds(sessionDisplayName)
          || !isMessageSenderWithinBounds(agent.canonical_key)
        ) {
          res.status(400).json({
            error: "Agent identity fields exceed the supported message-routing bounds.",
            code: "agent_identity_too_long",
          });
          return;
        }

        try {
          const created = await createFencedRoomAgentSession({
            room_id: project.id,
            session_kind: requestedSessionKind,
            runtime: normalizeRuntime(runtime || resolvedIdeLabel),
            registration_liveness: normalizedRegistrationLiveness,
            process_host_id: processHostId,
            repo_branch: normalizedRepoBranch,
            actor_label: actorLabel,
            agent_key: agent.canonical_key,
            agent_instance_id: normalizedAgentInstanceId,
            display_name: sessionDisplayName,
            // Persist the server-resolved base (before any collision suffix) as
            // durable allocation provenance for this session.
            assigned_base_display_name: baseDisplayName,
            connection_token,
            owner_account_id: req.sessionAccount.account_id,
            owner_label: agent.owner_label,
            ide_label: resolvedIdeLabel,
          }, replacementSessionId && replacementSessionToken ? {
            session_id: replacementSessionId,
            session_token: replacementSessionToken,
          } : null, takeoverSessionIds);
          // The database fence invalidates credentials first. Only after that
          // commit succeeds, wake any already-authenticated long-poll/SSE
          // request for the stable session id before returning the successor
          // credential. The successor cannot connect until this response.
          for (const replacedSessionId of [
            ...(durableWorker ? [] : created.replaced_session_ids),
            ...created.taken_over_session_ids,
          ]) {
            // A session registered again in place has not ended.
            if (replacedSessionId !== created.session.session_id) announceAgentSessionEnded(replacedSessionId);
            await disconnectRoomAgentDeliverySession({
              room_id: project.id,
              agent_session_id: replacedSessionId,
            });
          }
          res.status(201).json(created.session);
          return;
        } catch (error) {
          if (isActiveAgentInstanceConflictError(error)) {
            res.status(409).json({
              error: error.message,
              code: error.code,
              active_session_id: error.active_session_id,
            });
            return;
          }
          if (requestedSessionKind === "worker" && isActiveWorkerActorLabelConflict(error)) {
            usedDisplayNames.add(sessionDisplayName);
            offset++;
            continue;
          }
          if (isLockTimeout(error)) {
            // Another registration in this room is still committing.
            res.setHeader("Retry-After", "1");
            res.status(503).json({ error: "Agent session registration is busy. Retry shortly." });
            return;
          }
          throw error;
        }
      }

      res.status(409).json({
        error: "Could not allocate a unique active worker display name for this room.",
        code: "agent_session_display_name_exhausted",
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "POST /rooms/:room_id/agent-sessions",
        error,
        "Agent session could not be registered."
      );
    }
  });

  // The agent's process holds this connection open for as long as it runs.
  // It carries nothing: that it is open is the message. It is the server's
  // only evidence of whether the process still exists, because activity on
  // the session cannot tell a process that is gone from one that is busy or
  // waiting between room calls.
  app.get(/^\/rooms\/(.+)\/agent-sessions\/([^/]+)\/process$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const targetSessionId = decodeURIComponent((req.params as Record<string, string>)[1] ?? "").trim();
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const header = (name: string): string | undefined => {
      const value = req.headers?.[name.toLowerCase()];
      return typeof value === "string" ? value : undefined;
    };
    const identity = await requireWorkerRequestAgentIdentity({
      req,
      body: {
        agent_session_id: header(LETAGENTS_AGENT_SESSION_ID_HEADER),
        agent_session_token: header(LETAGENTS_AGENT_SESSION_TOKEN_HEADER),
      },
      room_id: project.id,
    });
    if (!identity.ok) {
      // A process whose session has ended is told so. It proved the session
      // was its own, and this is how it learns its name has passed on: it
      // had no connection open to be told over when that happened.
      const sessionId = header(LETAGENTS_AGENT_SESSION_ID_HEADER)?.trim();
      const sessionToken = header(LETAGENTS_AGENT_SESSION_TOKEN_HEADER)?.trim();
      const accountId = req.sessionAccount?.account_id;
      if (sessionId === targetSessionId && sessionToken && accountId) {
        try {
          if (await isEndedRoomAgentSessionCredential({
            session_id: sessionId, session_token: sessionToken, room_id: project.id, owner_account_id: accountId,
          })) {
            res.status(410).json({ error: "Agent session has ended.", code: "agent_session_ended" });
            return;
          }
        } catch (error) {
          respondWithInternalError(res, "GET /rooms/:room_id/agent-sessions/:id/process", error, "Process connection could not be opened.");
          return;
        }
      }
      res.status(identity.status).json({ error: identity.error });
      return;
    }
    if (identity.identity.agent_session_id !== targetSessionId) {
      res.status(403).json({ error: "A process connection belongs to its own session." });
      return;
    }

    let connectionId: string | null;
    try {
      connectionId = await openRoomAgentProcessConnection({ session_id: targetSessionId, room_id: project.id });
    } catch (error) {
      respondWithInternalError(res, "GET /rooms/:room_id/agent-sessions/:id/process", error, "Process connection could not be opened.");
      return;
    }
    if (!connectionId) {
      // The session has ended. The client stops rather than reconnects.
      res.status(410).json({ error: "Agent session has ended.", code: "agent_session_ended" });
      return;
    }

    const openedConnectionId = connectionId;
    const connection = openSseConnection(req, res, `agent process ${targetSessionId}`);
    // The process names this connection when it says it is exiting.
    void connection.write(`event: open\ndata: ${JSON.stringify({ connection_id: openedConnectionId })}\n\n`);
    // Set when this server closes the connection for a reason of its own.
    // Such a close says nothing about the process at the other end.
    let closedByServer = false;
    const sessionEnded = async () => {
      closedByServer = true;
      await connection.write("event: ended\ndata: {}\n\n");
      connection.close();
    };
    const release = holdAgentProcessConnection(targetSessionId, {
      sessionEnded: () => { void sessionEnded(); },
      serverLeaving: () => {
        closedByServer = true;
        connection.close();
      },
    });
    // A session that ends on this server is told at once, above. The
    // interval is what keeps the evidence current: it marks the process
    // seen, so that a server that dies without closing its connections
    // leaves evidence that goes stale instead of evidence that never does.
    // It also reaches a session ended by another server.
    let refreshing = false;
    const refresh = setInterval(() => {
      if (refreshing || connection.closed) return;
      refreshing = true;
      void refreshRoomAgentProcessConnection({ session_id: targetSessionId, connection_id: openedConnectionId })
        .then(async (state) => {
          if (state === "current") return;
          // Only an ended session is reported as ended. A replaced
          // connection is closed without comment: the session lives on.
          if (state === "ended") await sessionEnded();
          else connection.close();
        })
        .catch((error: unknown) => {
          console.error(`[agent process] failed to refresh ${targetSessionId}`, error);
        })
        .finally(() => { refreshing = false; });
    }, AGENT_PROCESS_CONNECTION_REFRESH_MS);
    refresh.unref?.();
    connection.addCleanup(async () => {
      clearInterval(refresh);
      release();
      if (closedByServer) return;
      await closeRoomAgentProcessConnection({ session_id: targetSessionId, connection_id: openedConnectionId });
    });
  });

  // A process on its way out says so. Unlike a closed connection, which may
  // reopen, this needs no waiting before its name can pass on. The session is
  // not ended: a durable worker returns to it when its process starts again.
  app.post(/^\/rooms\/(.+)\/agent-sessions\/([^/]+)\/process\/exit$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const targetSessionId = decodeURIComponent((req.params as Record<string, string>)[1] ?? "").trim();
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;
    const identity = await requireWorkerRequestAgentIdentity({
      req,
      body: (req.body ?? {}) as Record<string, unknown>,
      room_id: project.id,
    });
    if (!identity.ok) {
      res.status(identity.status).json({ error: identity.error });
      return;
    }
    if (identity.identity.agent_session_id !== targetSessionId) {
      res.status(403).json({ error: "A process speaks only for its own session." });
      return;
    }
    const connectionId = (req.body as Record<string, unknown> | undefined)?.process_connection_id;
    try {
      const recorded = await recordRoomAgentProcessExit({
        session_id: targetSessionId,
        room_id: project.id,
        connection_id: typeof connectionId === "string" && connectionId.trim() ? connectionId.trim() : null,
      });
      res.json({ recorded });
    } catch (error) {
      respondWithInternalError(res, "POST /rooms/:room_id/agent-sessions/:id/process/exit", error, "Process exit could not be recorded.");
    }
  });

  app.post(/^\/rooms\/(.+)\/agent-sessions\/([^/]+)\/disconnect$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const targetSessionId = decodeURIComponent((req.params as Record<string, string>)[1] ?? "").trim();
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!targetSessionId) {
      res.status(400).json({ error: "agent_session_id is required" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = req.body as {
      agent_session_id?: string;
      agent_session_token?: string;
    };
    const hasSelfCredentials = req.authKind === "agent_session"
      || typeof body.agent_session_id === "string" || typeof body.agent_session_token === "string";
    let ownerAccountScope: string | null = null;
    let credentialFence: ResolvedRequestAgentIdentity["credential_fence"] = null;

    if (hasSelfCredentials) {
      const agentSessionIdentity = await requireWorkerRequestAgentIdentity({
        req,
        body,
        room_id: project.id,
      });
      if (!agentSessionIdentity.ok) {
        res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
        return;
      }
      if (agentSessionIdentity.identity.agent_session_id !== targetSessionId) {
        res.status(403).json({ error: "Worker sessions can only disconnect themselves." });
        return;
      }
      ownerAccountScope = req.sessionAccount?.account_id ?? null;
      credentialFence = agentSessionIdentity.identity.credential_fence;
    } else if (!(await deps.requireAdmin(req, res, project))) {
      return;
    }

    try {
      const endedSession = await endRoomAgentSession({
        session_id: targetSessionId,
        room_id: project.id,
        owner_account_id: ownerAccountScope,
        credential_fence: credentialFence,
      });
      if (!endedSession) {
        res.status(404).json({ error: "Agent session not found" });
        return;
      }

      announceAgentSessionEnded(targetSessionId);
      // Ending already retires delivery and emits credential-scoped invalidations.
      // A later session-id-only disconnect could hit a reconnecting successor.
      const deliverySession = isMcpWorkerId(endedSession.agent_instance_id) ? null : await disconnectRoomAgentDeliverySession({
        room_id: project.id,
        agent_session_id: targetSessionId,
      });

      res.json({
        room_id: project.id,
        agent_session: endedSession,
        delivery_session: deliverySession,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "POST /rooms/:room_id/agent-sessions/:agent_session_id/disconnect",
        error,
        "Agent session could not be disconnected."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/agent-sessions\/([^/]+)\/failures$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const targetSessionId = decodeURIComponent((req.params as Record<string, string>)[1] ?? "").trim();
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = req.body as {
      agent_session_id?: string;
      agent_session_token?: string;
      code?: string;
      origin_event_id?: string | null;
    };
    const agentSessionIdentity = await requireWorkerRequestAgentIdentity({
      req,
      body,
      room_id: project.id,
    });
    if (!agentSessionIdentity.ok) {
      res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
      return;
    }
    if (agentSessionIdentity.identity.agent_session_id !== targetSessionId) {
      res.status(403).json({ error: "Worker sessions can only report their own failures." });
      return;
    }
    const code = String(body.code || "") as keyof typeof failureMessages;
    if (!(code in failureMessages)) {
      res.status(400).json({ error: "A supported managed-agent failure code is required." });
      return;
    }
    const originEventId = typeof body.origin_event_id === "string"
      ? body.origin_event_id.trim().slice(0, 128)
      : "";
    const identity = agentSessionIdentity.identity;
    const message = await deps.emitProjectMessage(
      project.id,
      "letagents",
      `${identity.display_name} could not reply: ${failureMessages[code]}`,
      {
        source: "managed_agent_failure",
        client_message_id: `managed_agent_failure:${targetSessionId}:${originEventId || "turn"}:${code}`,
      },
    );
    res.status(201).json({ ...message, room_id: project.id });
  });

  app.post(/^\/rooms\/(.+)\/agent-sessions\/([^/]+)\/desktop-heartbeat$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const targetSessionId = decodeURIComponent((req.params as Record<string, string>)[1] ?? "").trim();
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;
    const body = req.body as {
      agent_session_id?: string;
      agent_session_token?: string;
      delivery_signal_sequence?: unknown;
    };
    const worker = await requireWorkerRequestAgentIdentity({ req, body, room_id: project.id });
    if (!worker.ok) {
      res.status(worker.status).json({ error: worker.error });
      return;
    }
    if (worker.identity.agent_session_id !== targetSessionId) {
      res.status(403).json({ error: "Worker sessions can only heartbeat their own delivery lease." });
      return;
    }
    const deliverySignalSequence = body.delivery_signal_sequence === undefined
      ? 0
      : body.delivery_signal_sequence;
    if (!Number.isSafeInteger(deliverySignalSequence)
      || (deliverySignalSequence as number) < 0
      || (deliverySignalSequence as number) > 2_147_483_647) {
      res.status(400).json({ error: "delivery_signal_sequence must be a non-negative 32-bit integer." });
      return;
    }
    const identity = worker.identity;
    try {
      const { delivery, presence } = await upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat({
        room_id: project.id,
        actor_label: identity.actor_label,
        agent_key: identity.agent_key,
        agent_instance_id: identity.agent_instance_id,
        agent_session_id: targetSessionId,
        session_kind: identity.session_kind,
        runtime: identity.runtime,
        display_name: identity.display_name,
        owner_label: identity.owner_label,
        ide_label: identity.ide_label,
        repo_branch: identity.repo_branch,
        credential_fence: identity.credential_fence,
        desktop_signal_sequence: body.delivery_signal_sequence === undefined
          ? undefined
          : deliverySignalSequence as number,
        presence: {
          status: "idle",
          status_text: "Waiting for room messages",
        },
      });
      res.json({ room_id: project.id, delivery_session: delivery, presence });
    } catch (error) {
      if (isStaleDesktopRoomAgentDeliverySignalError(error)) {
        res.status(409).json({
          error: error.message,
          code: "stale_delivery_signal",
          current_delivery_signal_sequence: error.currentSequence,
        });
        return;
      }
      throw error;
    }
  });

  app.post(/^\/rooms\/(.+)\/agent-sessions\/([^/]+)\/native-activity$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const targetSessionId = decodeURIComponent((req.params as Record<string, string>)[1] ?? "").trim();
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    const body = req.body as {
      agent_session_id?: string;
      agent_session_token?: string;
      observed_at?: unknown;
      sequence?: unknown;
      method?: unknown;
      status?: unknown;
    };
    let identity: ResolvedRequestAgentIdentity | null = null;
    if (req.authKind === "agent_session") {
      // Scoped worker bearers authenticate in the HTTP middleware. Do not
      // reinterpret that bearer as the legacy owner-capable session token.
      const worker = await requireWorkerRequestAgentIdentity({ req, body: {}, room_id: project.id });
      if (!worker.ok) {
        res.status(worker.status).json({ error: worker.error });
        return;
      }
      identity = worker.identity;
    } else {
      // Compatibility for existing native bridges that still send the legacy
      // session credential in the body without an Authorization header.
      const suppliedSessionId = typeof body.agent_session_id === "string" ? body.agent_session_id.trim() : "";
      const suppliedSessionToken = typeof body.agent_session_token === "string" ? body.agent_session_token.trim() : "";
      const exactSession = suppliedSessionId && suppliedSessionToken
        ? await getRoomAgentSessionByCredentials({
          session_id: suppliedSessionId,
          session_token: suppliedSessionToken,
          room_id: project.id,
        })
        : null;
      if (exactSession) {
        identity = {
          actor_label: exactSession.actor_label,
          agent_key: exactSession.agent_key,
          agent_instance_id: exactSession.agent_instance_id,
          agent_session_id: exactSession.session_id,
          session_kind: exactSession.session_kind,
          runtime: exactSession.runtime,
          display_name: exactSession.display_name,
          owner_label: exactSession.owner_label,
          ide_label: exactSession.ide_label,
          repo_branch: exactSession.repo_branch ?? null,
        };
      }
    }
    if (!identity) {
      res.status(401).json({ error: "Invalid or ended native worker session credentials." });
      return;
    }
    if (identity.session_kind !== "worker") {
      res.status(403).json({ error: "Native activity requires a worker session." });
      return;
    }
    if (identity.agent_session_id !== targetSessionId) {
      res.status(403).json({ error: "Worker sessions can only report native activity for themselves." });
      return;
    }
    const observedAt = typeof body.observed_at === "string" ? body.observed_at : "";
    const observedMs = Date.parse(observedAt);
    const sequence = body.sequence;
    const method = typeof body.method === "string" ? body.method.trim().slice(0, 160) : "";
    // A native heartbeat is evidence of a connected provider, not work by
    // itself. Missing status therefore defaults to idle/listening, while an
    // explicitly supplied value must use the public presence vocabulary.
    const status = body.status === undefined
      ? "idle"
      : normalizeAgentPresenceStatus(body.status);
    const serverNowMs = Date.now();
    if (!Number.isFinite(observedMs) || observedMs > serverNowMs + 5_000 || serverNowMs - observedMs > 10 * 60 * 1000
      || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1 || !method || !status) {
      res.status(400).json({ error: "observed_at, positive integer sequence, native method, and a valid native status are required." });
      return;
    }
    try {
      const result = await recordNativeHarnessActivity({
        room_id: project.id,
        agent_session_id: targetSessionId,
        actor_label: identity.actor_label,
        agent_key: identity.agent_key,
        session_kind: "worker",
        runtime: identity.runtime,
        display_name: identity.display_name,
        owner_label: identity.owner_label,
        ide_label: identity.ide_label,
        repo_branch: identity.repo_branch,
        provider_observed_at: observedAt,
        sequence,
        method,
        status,
      });
      res.json({ room_id: project.id, axis: "execution_activity", ...result });
    } catch (error) {
      respondWithInternalError(res, "POST /rooms/:room/agent-sessions/:session/native-activity", error, "Native activity could not be recorded.");
    }
  });

  app.post(/^\/rooms\/(.+)\/agent-sessions\/([^/]+)\/desktop-pause$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const targetSessionId = decodeURIComponent((req.params as Record<string, string>)[1] ?? "").trim();
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;
    const body = req.body as {
      agent_session_id?: string;
      agent_session_token?: string;
      status_text?: string;
      availability?: "failure" | "room_closed";
      delivery_signal_sequence?: unknown;
    };
    const worker = await requireWorkerRequestAgentIdentity({ req, body, room_id: project.id });
    if (!worker.ok) {
      res.status(worker.status).json({ error: worker.error });
      return;
    }
    if (worker.identity.agent_session_id !== targetSessionId) {
      res.status(403).json({ error: "Worker sessions can only pause their own delivery lease." });
      return;
    }
    const deliverySignalSequence = body.delivery_signal_sequence === undefined
      ? 0
      : body.delivery_signal_sequence;
    if (!Number.isSafeInteger(deliverySignalSequence)
      || (deliverySignalSequence as number) < 0
      || (deliverySignalSequence as number) > 2_147_483_647) {
      res.status(400).json({ error: "delivery_signal_sequence must be a non-negative 32-bit integer." });
      return;
    }
    const identity = worker.identity;
    const pausePresence = desktopManagedPausePresence({
      availability: body.availability,
      statusText: typeof body.status_text === "string" ? body.status_text : undefined,
    });
    try {
      const { delivery, presence } = await pauseDesktopRoomAgentDelivery({
        room_id: project.id,
        actor_label: identity.actor_label,
        agent_key: identity.agent_key,
        agent_instance_id: identity.agent_instance_id,
        agent_session_id: targetSessionId,
        session_kind: identity.session_kind,
        runtime: identity.runtime,
        display_name: identity.display_name,
        owner_label: identity.owner_label,
        ide_label: identity.ide_label,
        repo_branch: identity.repo_branch,
        credential_fence: identity.credential_fence,
        desktop_signal_sequence: deliverySignalSequence as number,
        presence: {
          room_id: project.id,
          actor_label: identity.actor_label,
          agent_key: identity.agent_key,
          agent_session_id: targetSessionId,
          session_kind: identity.session_kind,
          runtime: identity.runtime,
          display_name: identity.display_name,
          owner_label: identity.owner_label,
          ide_label: identity.ide_label,
          repo_branch: identity.repo_branch,
          status: pausePresence.status,
          status_text: pausePresence.statusText,
        },
      });
      res.json({ room_id: project.id, delivery_session: delivery, presence });
    } catch (error) {
      if (isStaleDesktopRoomAgentDeliverySignalError(error)) {
        res.status(409).json({
          error: error.message,
          code: "stale_delivery_signal",
          current_delivery_signal_sequence: error.currentSequence,
        });
        return;
      }
      throw error;
    }
  });
}
