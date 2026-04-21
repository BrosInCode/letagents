import type { Express, Response } from "express";

import {
  getFocusRoomsForParent,
  getMessages,
  getRoomAgentPresence,
  getRoomParticipants,
  getRoomParticipantsForRooms,
  getProjectById,
  getTasksForRooms,
  setRoomParticipantsHidden,
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
import {
  buildRoomActivityHistoryEntries,
  filterRoomActivityHistoryEntries,
  paginateRoomActivityHistoryEntries,
  type RoomActivityHistoryKind,
} from "../room-activity-history.js";
import { buildFallbackPresenceFromMessages, buildSyntheticPresenceEntry } from "../presence-fallback.js";
import { buildFallbackRoomParticipants } from "../room-participant-fallback.js";
import { normalizeRoomId } from "../room-routing.js";
import {
  normalizeAgentPresenceStatus,
  type AgentPresenceStatus,
} from "../../shared/agent-presence.js";

export interface RoomPresenceRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
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

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHistoryKind(value: unknown): RoomActivityHistoryKind {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "agent" || normalized === "human" ? normalized : "all";
}

function normalizeActorLabel(value: string | null | undefined): string {
  return String(value ?? "").trim();
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
        `[presence] failed to read stored room presence for ${project.id}; falling back to recent agent messages`,
        error
      );

      const fallbackMessageLimit = Math.min(Math.max(limit * 4, 100), 200);
      const fallbackMessages = await getMessages(project.id, { limit: fallbackMessageLimit });
      const presence = buildFallbackPresenceFromMessages({
        roomId: project.id,
        messages: fallbackMessages.messages,
      }).slice(0, limit);

      res.json({
        room_id: project.id,
        presence: presence.map(toPublicRoomAgentPresence),
        fallback: "recent_agent_messages",
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
      const storedParticipants = await getRoomParticipants(project.id, { limit, includeHidden: true });
      if (storedParticipants.length > 0) {
        res.json({
          room_id: project.id,
          participants: storedParticipants
            .filter((participant) => !participant.hidden_at)
            .map(toPublicRoomParticipant),
          hidden_count: storedParticipants.filter((participant) => Boolean(participant.hidden_at)).length,
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
        hidden_count: 0,
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

  app.get(/^\/rooms\/(.+)\/activity-history$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    try {
      const rootRoom = project.parent_room_id
        ? (await getProjectById(project.parent_room_id)) ?? project
        : project;
      const focusRooms = rootRoom.kind === "main"
        ? await getFocusRoomsForParent(rootRoom.id)
        : [];
      const rooms = [rootRoom, ...focusRooms];
      const roomIds = rooms.map((room) => room.id);
      const [participants, roomTasks, currentRoomParticipants] = await Promise.all([
        getRoomParticipantsForRooms(roomIds, { includeHidden: true }),
        getTasksForRooms(roomIds),
        getRoomParticipantsForRooms([project.id], { includeHidden: true }),
      ]);
      const entries = buildRoomActivityHistoryEntries({
        rooms,
        participants,
        tasks: roomTasks,
      });
      const filtered = filterRoomActivityHistoryEntries(entries, {
        kind: normalizeHistoryKind(req.query.kind),
        query: typeof req.query.query === "string" ? req.query.query : null,
      });
      const paginated = paginateRoomActivityHistoryEntries(filtered, {
        page: parsePositiveInteger(req.query.page, 1),
        pageSize: parsePositiveInteger(req.query.page_size, 20),
      });

      res.json({
        room_id: project.id,
        root_room_id: rootRoom.id,
        hidden_count: currentRoomParticipants.filter((participant) => Boolean(participant.hidden_at)).length,
        ...paginated,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "GET /rooms/:room_id/activity-history",
        error,
        "Room activity history could not be loaded."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/participants\/archive-disconnected$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireAdmin(req, res, project))) return;

    try {
      const [participants, presence] = await Promise.all([
        getRoomParticipantsForRooms([project.id], { includeHidden: true }),
        getRoomAgentPresence(project.id, { limit: 500 }),
      ]);
      const activeActors = new Set(
        presence
          .filter((entry) => entry.freshness === "active")
          .map((entry) => normalizeActorLabel(entry.actor_label))
          .filter(Boolean)
      );
      const archiveKeys = participants
        .filter((participant) =>
          participant.kind === "agent"
          && !participant.hidden_at
          && !activeActors.has(normalizeActorLabel(participant.actor_label))
        )
        .map((participant) => participant.participant_key);
      const archivedCount = await setRoomParticipantsHidden({
        room_id: project.id,
        participant_keys: archiveKeys,
        hidden: true,
        hidden_by: req.sessionAccount?.login ?? "room-admin",
      });

      res.json({
        room_id: project.id,
        archived_count: archivedCount,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "POST /rooms/:room_id/participants/archive-disconnected",
        error,
        "Disconnected participants could not be archived."
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
