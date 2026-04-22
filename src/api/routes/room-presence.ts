import type { Express, Response } from "express";

import {
  getMessages,
  getRoomAgentPresence,
  getRoomParticipants,
  upsertRoomAgentPresence,
  type Project,
  type RoomAgentPresence,
  type RoomParticipant,
} from "../db.js";
import {
  parseLimit,
  respondWithInternalError,
  type AuthenticatedRequest,
} from "../http-helpers.js";
import { buildSyntheticPresenceEntry } from "../presence-fallback.js";
import { buildFallbackRoomParticipants } from "../room-participant-fallback.js";
import { normalizeRoomId } from "../room-routing.js";
import {
  normalizeAgentPresenceStatus,
  type AgentPresenceStatus,
} from "../../shared/agent-presence.js";

export interface RoomPresenceRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  rememberAgentRoomParticipant(input: {
    projectId: string;
    actorLabel?: string | null;
    agentKey?: string | null;
    displayName?: string | null;
    ownerLabel?: string | null;
    ideLabel?: string | null;
    lastSeenAt?: string | null;
  }): Promise<void>;
  maybeEmitStaleWorkPrompt(projectId: string): Promise<unknown>;
}

function toPublicRoomAgentPresence(presence: RoomAgentPresence): RoomAgentPresence {
  return {
    ...presence,
  };
}

function toPublicRoomParticipant(participant: RoomParticipant): RoomParticipant {
  return {
    ...participant,
  };
}

export function registerRoomPresenceRoutes(
  app: Express,
  deps: RoomPresenceRouteDeps
): void {
  app.get(/^(?:\/api)?\/rooms\/(.+)\/presence$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined) ?? 50;
    try {
      const presence = await getRoomAgentPresence(project.id, { limit });

      res.json({
        room_id: project.id,
        presence: presence.map(toPublicRoomAgentPresence),
      });
    } catch (error) {
      console.error(
        `[presence] failed to read canonical room presence for ${project.id}; returning an empty live roster`,
        error
      );

      res.json({
        room_id: project.id,
        presence: [],
        fallback: "unavailable",
      });
    }
  });

  app.get(/^\/rooms\/(.+)\/participants$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined) ?? 100;

    try {
      const participants = await getRoomParticipants(project.id, { limit });
      if (participants.length > 0) {
        res.json({
          room_id: project.id,
          participants: participants.map(toPublicRoomParticipant),
        });
        return;
      }

      const fallbackMessageLimit = Math.min(Math.max(limit * 4, 100), 200);
      const [messagesResult, presence] = await Promise.all([
        getMessages(project.id, { limit: fallbackMessageLimit }),
        getRoomAgentPresence(project.id, { limit }),
      ]);

      const participantsFromHistory = buildFallbackRoomParticipants({
        roomId: project.id,
        messages: messagesResult.messages,
        presence,
      }).slice(0, limit);

      res.json({
        room_id: project.id,
        participants: participantsFromHistory.map(toPublicRoomParticipant),
        fallback: "room_history",
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "GET /rooms/:room_id/participants",
        error,
        "Room participants could not be loaded."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/presence$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const {
      actor_label,
      agent_key,
      display_name,
      owner_label,
      ide_label,
      status,
      status_text,
    } = req.body as {
      actor_label?: string;
      agent_key?: string | null;
      display_name?: string;
      owner_label?: string | null;
      ide_label?: string | null;
      status?: string;
      status_text?: string | null;
    };

    const actorLabel = typeof actor_label === "string" ? actor_label.trim() : "";
    const displayName = typeof display_name === "string" ? display_name.trim() : "";
    const agentKey = typeof agent_key === "string" ? agent_key.trim() || null : null;
    const ownerLabel = typeof owner_label === "string" ? owner_label.trim() || null : null;
    const ideLabel = typeof ide_label === "string" ? ide_label.trim() || null : null;
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
        display_name: displayName,
        owner_label: ownerLabel,
        ide_label: ideLabel,
        status: normalizedStatus as AgentPresenceStatus,
        status_text: statusText,
      });
      await deps.rememberAgentRoomParticipant({
        projectId: project.id,
        actorLabel: presence.actor_label,
        agentKey: presence.agent_key,
        displayName: presence.display_name,
        ownerLabel: presence.owner_label,
        ideLabel: presence.ide_label,
        lastSeenAt: presence.last_heartbeat_at,
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
