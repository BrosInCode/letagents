import type { Express } from "express";

import {
  upsertRoomAgentLivenessObservation,
  upsertRoomAgentPresence,
} from "../../../db.js";
import {
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import { buildSyntheticPresenceEntry } from "../../../presence/fallback.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import { requireWorkerRequestAgentIdentity } from "../../../request/agent-identity.js";
import {
  normalizeAgentPresenceStatus,
  type AgentPresenceStatus,
} from "../../../../shared/agent-presence.js";
import {
  normalizeRegistrationLiveness,
  toPublicRoomAgentPresence,
} from "./helpers.js";
import type { RoomPresenceRouteDeps } from "./types.js";

export function registerPresenceUpdateRoutes(
  app: Express,
  deps: RoomPresenceRouteDeps
): void {
  app.post(/^\/rooms\/(.+)\/presence$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const { status, status_text, agent_session_id, agent_session_token, liveness_observation } = req.body as {
      status?: string;
      status_text?: string | null;
      agent_session_id?: string;
      agent_session_token?: string;
      liveness_observation?: unknown;
    };

    const agentSessionIdentity = await requireWorkerRequestAgentIdentity({
      req,
      body: { agent_session_id, agent_session_token },
      room_id: project.id,
    });
    if (!agentSessionIdentity.ok) {
      res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
      return;
    }

    const actorLabel = agentSessionIdentity.identity.actor_label;
    const displayName = agentSessionIdentity.identity.display_name;
    const agentKey = agentSessionIdentity.identity.agent_key;
    const ownerLabel = agentSessionIdentity.identity.owner_label;
    const ideLabel = agentSessionIdentity.identity.ide_label;
    const statusText = typeof status_text === "string" ? status_text.trim() || null : null;
    const normalizedStatus = normalizeAgentPresenceStatus(status);

    if (!actorLabel || !displayName || !normalizedStatus) {
      res.status(400).json({
        error: "actor_label, display_name, and a valid status are required",
      });
      return;
    }

    try {
      const presence = await upsertRoomAgentPresence({
        room_id: project.id,
        actor_label: actorLabel,
        agent_key: agentKey,
        agent_session_id: agentSessionIdentity.identity.agent_session_id,
        session_kind: agentSessionIdentity.identity.session_kind,
        runtime: agentSessionIdentity.identity.runtime,
        display_name: displayName,
        owner_label: ownerLabel,
        ide_label: ideLabel,
        repo_branch: agentSessionIdentity.identity.repo_branch,
        status: normalizedStatus as AgentPresenceStatus,
        status_text: statusText,
      });
      const normalizedLiveness = normalizeRegistrationLiveness(liveness_observation);
      if (normalizedLiveness && agentSessionIdentity.identity.agent_session_id) {
        try {
          presence.liveness_observation = await upsertRoomAgentLivenessObservation({
            room_id: project.id,
            agent_session_id: agentSessionIdentity.identity.agent_session_id,
            source: "agent_session",
            ...normalizedLiveness,
            last_observed_at: new Date().toISOString(),
            last_tool_call_at: new Date().toISOString(),
            detail: statusText,
          });
        } catch (error) {
          console.error(
            `[presence] failed to persist liveness observation for ${project.id}; continuing with standard presence`,
            error
          );
        }
      }
      await deps.rememberAgentRoomParticipant({
        projectId: project.id,
        actorLabel: presence.actor_label,
        agentKey: presence.agent_key,
        displayName: presence.display_name,
        ownerLabel: presence.owner_label,
        ideLabel: presence.ide_label,
        lastSeenAt: presence.last_heartbeat_at,
        preserveLastSeenAtOnConflict: true,
      });

      await deps.maybeEmitStaleWorkPrompt(project.id);

      res.status(200).json({
        ...toPublicRoomAgentPresence(presence),
      });
    } catch (error) {
      console.error(
        `[presence] failed to persist room presence for ${project.id}; returning a synthetic presence response`,
        error
      );

      const presence = buildSyntheticPresenceEntry({
        roomId: project.id,
        actorLabel,
        agentKey,
        displayName,
        ownerLabel,
        ideLabel,
        repoBranch: agentSessionIdentity.identity.repo_branch,
        status: normalizedStatus as AgentPresenceStatus,
        statusText,
      });

      res.status(200).json({
        ...toPublicRoomAgentPresence(presence),
        fallback: "synthetic_response",
      });
    }
  });
}
