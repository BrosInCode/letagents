import type { Express, Response } from "express";

import {
  getFocusRoomsForParent,
  getMessages,
  getRoomAgentPresence,
  getRoomAgentPresenceSnapshot,
  getRoomParticipants,
  getRoomParticipantsForRooms,
  getProjectById,
  getTasksForRooms,
  setRoomLiveAgentSuppressed,
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
import { buildSyntheticPresenceEntry } from "../presence-fallback.js";
import {
  buildRoomActivityHistoryEntries,
  filterRoomActivityHistoryEntries,
  paginateRoomActivityHistoryEntries,
  sortRoomActivityHistoryEntries,
  type RoomActivityHistoryKind,
} from "../room-activity-history.js";
import {
  decorateRoomActivityHistoryEntriesWithPresence,
  decorateRoomParticipantsWithPresence,
} from "../room-activity-state.js";
import { buildFallbackRoomParticipants } from "../room-participant-fallback.js";
import { normalizeRoomId } from "../room-routing.js";
import {
  normalizeAgentPresenceStatus,
  type AgentPresenceStatus,
} from "../../shared/agent-presence.js";
import { isWithinRecentlyOfflineWindow } from "../../shared/room-agent-activity.js";

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

function normalizeHistoryRoomId(value: unknown): string | null {
  const normalized = normalizeRoomId(String(value ?? "").trim());
  return normalized || null;
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
      const [storedParticipants, storedPresence] = await Promise.all([
        getRoomParticipants(project.id, { limit, includeHidden: true }),
        getRoomAgentPresence(project.id, { limit: 500 }).catch(() => []),
      ]);
      if (storedParticipants.length > 0) {
        const participants = decorateRoomParticipantsWithPresence({
          participants: storedParticipants,
          presence: storedPresence,
        });
        res.json({
          room_id: project.id,
          participants: participants
            .filter((participant) => !participant.hidden_at)
            .map(toPublicRoomParticipant),
          hidden_count: participants.filter((participant) => Boolean(participant.hidden_at)).length,
        });
        return;
      }

      const fallbackMessageLimit = Math.min(Math.max(limit * 4, 100), 200);
      const [messagesResult, presence] = await Promise.all([
        getMessages(project.id, { limit: fallbackMessageLimit }),
        getRoomAgentPresence(project.id, { limit }).catch(() => []),
      ]);

      const participantsFromHistory = decorateRoomParticipantsWithPresence({
        participants: buildFallbackRoomParticipants({
          roomId: project.id,
          messages: messagesResult.messages,
          presence,
        }),
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
      const selectedRoomId = normalizeHistoryRoomId(req.query.room_id) ?? project.id;
      const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? project;
      const scopedRooms = rooms.filter((room) => room.id === selectedRoom.id);
      const [selectedRoomParticipants, roomTasks, selectedRoomPresence] = await Promise.all([
        getRoomParticipantsForRooms([selectedRoom.id], { includeHidden: true }),
        getTasksForRooms([selectedRoom.id]),
        getRoomAgentPresenceSnapshot(selectedRoom.id).catch(() => []),
      ]);
      const historyParticipants = selectedRoomParticipants.length > 0
        ? selectedRoomParticipants
        : buildFallbackRoomParticipants({
          roomId: selectedRoom.id,
          messages: (await getMessages(selectedRoom.id, { limit: 200 })).messages,
          presence: selectedRoomPresence,
        });
      const entries = decorateRoomActivityHistoryEntriesWithPresence({
        entries: buildRoomActivityHistoryEntries({
          rooms: scopedRooms,
          participants: historyParticipants,
          tasks: roomTasks,
        }),
        presence: selectedRoomPresence,
      });
      const filtered = filterRoomActivityHistoryEntries(entries, {
        roomId: selectedRoom.id,
        kind: normalizeHistoryKind(req.query.kind),
        query: typeof req.query.query === "string" ? req.query.query : null,
      });
      const paginated = paginateRoomActivityHistoryEntries(sortRoomActivityHistoryEntries(filtered), {
        page: parsePositiveInteger(req.query.page, 1),
        pageSize: parsePositiveInteger(req.query.page_size, 20),
      });

      res.json({
        room_id: project.id,
        root_room_id: rootRoom.id,
        selected_room_id: selectedRoom.id,
        hidden_count: historyParticipants.filter((participant) => Boolean(participant.hidden_at)).length,
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
        getRoomAgentPresenceSnapshot(project.id),
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
      const suppressedActorLabels = Array.from(new Set(
        presence
          .filter((entry) =>
            entry.freshness !== "active"
            && isWithinRecentlyOfflineWindow(entry.last_heartbeat_at)
          )
          .map((entry) => normalizeActorLabel(entry.actor_label))
          .filter(Boolean)
      ));
      const [hiddenParticipantCount, suppressedCount] = await Promise.all([
        setRoomParticipantsHidden({
          room_id: project.id,
          participant_keys: archiveKeys,
          hidden: true,
          hidden_by: req.sessionAccount?.login ?? "room-admin",
        }),
        setRoomLiveAgentSuppressed({
          room_id: project.id,
          actor_labels: suppressedActorLabels,
          suppressed: true,
          suppressed_by: req.sessionAccount?.login ?? "room-admin",
        }),
      ]);

      res.json({
        room_id: project.id,
        archived_count: hiddenParticipantCount,
        participant_hidden_count: hiddenParticipantCount,
        suppressed_count: suppressedCount,
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
