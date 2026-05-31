import type { Express } from "express";

import {
  createRoomAgentSession,
  endRoomAgentSession,
  getActiveRoomAgentSessionsForWorkerIdentity,
  getAgentIdentityByCanonicalKey,
  getRoomParticipants,
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
  normalizeRegistrationLiveness,
  normalizeRuntime,
} from "./helpers.js";
import type { RoomPresenceRouteDeps } from "./types.js";

export function registerAgentSessionRoutes(
  app: Express,
  deps: RoomPresenceRouteDeps
): void {
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
      registration_liveness,
    } = req.body as {
      actor_key?: string;
      actor_label?: string;
      display_name?: string;
      ide_label?: string;
      agent_instance_id?: string | null;
      session_kind?: string;
      runtime?: string;
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

      const baseDisplayName = isGenericName
        ? pickLocalCodename(agent.canonical_key).display_name
        : (requestedDisplayName || agent.display_name);
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
    const hasSelfCredentials =
      typeof body.agent_session_id === "string" || typeof body.agent_session_token === "string";
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
}
