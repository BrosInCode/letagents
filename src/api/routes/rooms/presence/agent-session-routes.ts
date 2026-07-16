import type { Express } from "express";

import {
  createRoomAgentSession,
  endRoomAgentSession,
  forceDisconnectRoomAgentDeliverySession,
  getActiveRoomAgentSessionsForWorkerIdentity,
  getAgentIdentityByCanonicalKey,
  getLastEndedWorkerSessionDisplayName,
  getRoomAgentSessionByCredentials,
  getRoomParticipants,
  recordNativeHarnessActivity,
  upsertDesktopRoomAgentDeliveryHeartbeat,
  upsertRoomAgentPresence,
} from "../../../db.js";
import {
  respondWithInternalError,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import { disconnectRoomAgentDeliverySession } from "../../../rooms/agent-delivery.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import { requireWorkerRequestAgentIdentity } from "../../../request/agent-identity.js";
import { buildAgentActorLabel, parseAgentActorLabel } from "../../../../shared/agent-identity.js";
import { pickLocalCodename } from "../../../../shared/codenames.js";
import { normalizeRoomAgentSessionKind } from "../../../../shared/agent-presence.js";
import {
  isActiveWorkerActorLabelConflict,
  normalizeOptionalText,
  normalizeRegistrationLiveness,
  normalizeRuntime,
} from "./helpers.js";
import type { RoomPresenceRouteDeps } from "./types.js";

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
      ide_label,
      agent_instance_id,
      session_kind,
      runtime,
      repo_branch,
      registration_liveness,
    } = req.body as {
      actor_key?: string;
      actor_label?: string;
      display_name?: string;
      ide_label?: string;
      agent_instance_id?: string | null;
      session_kind?: string;
      runtime?: string;
      repo_branch?: string | null;
      registration_liveness?: unknown;
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

      const canonicalDisplayName = agent.display_name.trim();
      const normalizedRequestedDisplayName = normalizeReplayedAgentDisplayName(
        requestedDisplayName,
        canonicalDisplayName
      );

      let baseDisplayName = isGenericName
        ? pickLocalCodename(agent.canonical_key).display_name
        : (normalizedRequestedDisplayName || canonicalDisplayName);
      const requestedSessionKind = normalizeRoomAgentSessionKind(session_kind || "worker");
      const [activeParticipants, activeSessionsForIdentity] = await Promise.all([
        getRoomParticipants(project.id, { limit: 200 }),
        requestedSessionKind === "worker"
          ? getActiveRoomAgentSessionsForWorkerIdentity({
              room_id: project.id,
              agent_key: agent.canonical_key,
            })
          : Promise.resolve([]),
      ]);
      const usedDisplayNames = new Set([
        ...activeParticipants.map((participant) => participant.display_name),
        ...activeSessionsForIdentity.map((session) => session.display_name),
      ]);

      // Participant rows are durable room history, not proof that a label is
      // still live. A restarted worker using the same canonical identity may
      // reclaim its base label once no active session for that identity holds
      // it. Never reclaim a label that belongs to a human or another agent:
      // genuinely concurrent/same-name peers still need disambiguation.
      if (requestedSessionKind === "worker") {
        const baseHeldByThisIdentity = activeSessionsForIdentity.some(
          (session) => session.display_name === baseDisplayName
        );
        const baseBelongsToAnotherParticipant = activeParticipants.some(
          (participant) => participant.display_name === baseDisplayName
            && (participant.kind !== "agent" || participant.agent_key !== agent.canonical_key)
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
      if (requestedSessionKind === "worker" && priorInstanceId) {
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
          && !activeSessionsForIdentity.some((session) => session.display_name === resumableName)
        ) {
          usedDisplayNames.delete(resumableName);
          baseDisplayName = resumableName;
        }
      }
      const pickSessionDisplayName = (suffixOffset: number): string => (
        suffixOffset === 0
          ? baseDisplayName
          : isGenericName
            ? pickLocalCodename(`${agent.canonical_key}:${suffixOffset}`).display_name
            : `${baseDisplayName} ${suffixOffset}`
      );

      let offset = 0;
      const normalizedAgentInstanceId = typeof agent_instance_id === "string" ? agent_instance_id.trim() || null : null;
      const normalizedRegistrationLiveness = normalizeRegistrationLiveness(registration_liveness);
      const normalizedRepoBranch = normalizeOptionalText(repo_branch);
      const maxRegistrationAttempts = 25;
      for (let attempt = 0; attempt < maxRegistrationAttempts; attempt += 1) {
        let sessionDisplayName = pickSessionDisplayName(offset);
        while (usedDisplayNames.has(sessionDisplayName)) {
          offset++;
          sessionDisplayName = pickSessionDisplayName(offset);
        }
        const actorLabel = buildAgentActorLabel({
          display_name: sessionDisplayName,
          owner_label: agent.owner_label,
          ide_label: resolvedIdeLabel,
        });

        try {
          const session = await createRoomAgentSession({
            room_id: project.id,
            session_kind: requestedSessionKind,
            runtime: normalizeRuntime(runtime || resolvedIdeLabel),
            registration_liveness: normalizedRegistrationLiveness,
            repo_branch: normalizedRepoBranch,
            actor_label: actorLabel,
            agent_key: agent.canonical_key,
            agent_instance_id: normalizedAgentInstanceId,
            display_name: sessionDisplayName,
            owner_account_id: req.sessionAccount.account_id,
            owner_label: agent.owner_label,
            ide_label: resolvedIdeLabel,
          });

          res.status(201).json(session);
          return;
        } catch (error) {
          if (requestedSessionKind === "worker" && isActiveWorkerActorLabelConflict(error)) {
            usedDisplayNames.add(sessionDisplayName);
            offset++;
            continue;
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
    } else if (!(await deps.requireAdmin(req, res, project))) {
      return;
    }

    try {
      const endedSession = await endRoomAgentSession({
        session_id: targetSessionId,
        room_id: project.id,
        owner_account_id: ownerAccountScope,
      });
      if (!endedSession) {
        res.status(404).json({ error: "Agent session not found" });
        return;
      }

      const deliverySession = await disconnectRoomAgentDeliverySession({
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
    const body = req.body as { agent_session_id?: string; agent_session_token?: string };
    const worker = await requireWorkerRequestAgentIdentity({ req, body, room_id: project.id });
    if (!worker.ok) {
      res.status(worker.status).json({ error: worker.error });
      return;
    }
    if (worker.identity.agent_session_id !== targetSessionId) {
      res.status(403).json({ error: "Worker sessions can only heartbeat their own delivery lease." });
      return;
    }
    const identity = worker.identity;
    const [delivery, presence] = await Promise.all([
      upsertDesktopRoomAgentDeliveryHeartbeat({
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
      }),
      upsertRoomAgentPresence({
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
        status: "idle",
        status_text: "Waiting for room messages",
      }),
    ]);
    res.json({ room_id: project.id, delivery_session: delivery, presence });
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
    const suppliedSessionId = typeof body.agent_session_id === "string" ? body.agent_session_id.trim() : "";
    const suppliedSessionToken = typeof body.agent_session_token === "string" ? body.agent_session_token.trim() : "";
    const exactSession = suppliedSessionId && suppliedSessionToken
      ? await getRoomAgentSessionByCredentials({
        session_id: suppliedSessionId,
        session_token: suppliedSessionToken,
        room_id: project.id,
      })
      : null;
    if (!exactSession) {
      res.status(401).json({ error: "Invalid or ended native worker session credentials." });
      return;
    }
    if (exactSession.session_kind !== "worker") {
      res.status(403).json({ error: "Native activity requires a worker session." });
      return;
    }
    if (exactSession.session_id !== targetSessionId) {
      res.status(403).json({ error: "Worker sessions can only report native activity for themselves." });
      return;
    }
    const observedAt = typeof body.observed_at === "string" ? body.observed_at : "";
    const observedMs = Date.parse(observedAt);
    const sequence = body.sequence;
    const method = typeof body.method === "string" ? body.method.trim().slice(0, 160) : "";
    const status = typeof body.status === "string" ? body.status.trim().slice(0, 32) : "working";
    const serverNowMs = Date.now();
    if (!Number.isFinite(observedMs) || observedMs > serverNowMs + 5_000 || serverNowMs - observedMs > 10 * 60 * 1000
      || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1 || !method) {
      res.status(400).json({ error: "observed_at, positive integer sequence, and native method are required." });
      return;
    }
    try {
      const result = await recordNativeHarnessActivity({
        room_id: project.id,
        agent_session_id: targetSessionId,
        actor_label: exactSession.actor_label,
        agent_key: exactSession.agent_key,
        session_kind: "worker",
        runtime: exactSession.runtime,
        display_name: exactSession.display_name,
        owner_label: exactSession.owner_label,
        ide_label: exactSession.ide_label,
        repo_branch: exactSession.repo_branch ?? null,
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
    const identity = worker.identity;
    const pausePresence = desktopManagedPausePresence({
      availability: body.availability,
      statusText: typeof body.status_text === "string" ? body.status_text : undefined,
    });
    const [delivery, presence] = await Promise.all([
      forceDisconnectRoomAgentDeliverySession({ room_id: project.id, agent_session_id: targetSessionId }),
      upsertRoomAgentPresence({
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
      }),
    ]);
    res.json({ room_id: project.id, delivery_session: delivery, presence });
  });
}
