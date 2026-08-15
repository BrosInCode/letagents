import type { Express } from "express";

import {
  getFocusRoomsForParent,
  getMessages,
  getRoomMessageCountsBySender,
  getRoomAgentPresence,
  getRoomAgentPresenceSnapshot,
  getRoomReasoningSessionCountsByActor,
  getRoomParticipants,
  getRoomParticipantsForRooms,
  getProjectById,
  getTasksForRooms,
} from "../../../db.js";
import {
  parseLimit,
  respondWithInternalError,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import {
  buildRoomActivityHistoryEntries,
  decorateRoomActivityHistoryEntriesWithCounts,
  filterRoomActivityHistoryEntries,
  paginateRoomActivityHistoryEntries,
  sortRoomActivityHistoryEntries,
} from "../../../rooms/activity-history.js";
import {
  decorateRoomActivityHistoryEntriesWithPresence,
  decorateRoomParticipantsWithPresence,
} from "../../../rooms/activity-state.js";
import { buildFallbackRoomParticipants } from "../../../rooms/participant-fallback.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import {
  buildRoomActivityHistoryParticipants,
  normalizeHistoryKind,
  normalizeHistoryRoomId,
  parsePositiveInteger,
  toPublicRoomAgentPresence,
  toPublicRoomParticipant,
} from "./helpers.js";
import type { RoomPresenceRouteDeps } from "./types.js";

export function registerPresenceReadRoutes(
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
    const scope = typeof req.query.scope === "string" ? req.query.scope.trim().toLowerCase() : "live";
    try {
      const presence = scope === "snapshot"
        ? (await getRoomAgentPresenceSnapshot(project.id))
            .filter((entry) => entry.session_kind === "worker")
            .slice(0, limit)
        : await getRoomAgentPresence(project.id, { limit });

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
      const [
        selectedRoomParticipants,
        roomTasks,
        selectedRoomPresence,
        messageCounts,
        reasoningSessionCounts,
      ] = await Promise.all([
        getRoomParticipantsForRooms([selectedRoom.id], { includeHidden: true }),
        getTasksForRooms([selectedRoom.id]),
        getRoomAgentPresenceSnapshot(selectedRoom.id, { includeEndedSessions: true }).catch(() => []),
        getRoomMessageCountsBySender(selectedRoom.id).catch(() => []),
        getRoomReasoningSessionCountsByActor(selectedRoom.id).catch(() => []),
      ]);
      const fallbackMessages = selectedRoomParticipants.length > 0
        ? []
        : (await getMessages(selectedRoom.id, { limit: 200 })).messages;
      const historyParticipants = buildRoomActivityHistoryParticipants({
        roomId: selectedRoom.id,
        storedParticipants: selectedRoomParticipants,
        presence: selectedRoomPresence,
        fallbackMessages,
      });
      const entries = decorateRoomActivityHistoryEntriesWithCounts({
        entries: decorateRoomActivityHistoryEntriesWithPresence({
          entries: buildRoomActivityHistoryEntries({
            rooms: scopedRooms,
            participants: historyParticipants,
            tasks: roomTasks,
          }),
          presence: selectedRoomPresence,
        }),
        messageCounts,
        reasoningSessionCounts,
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
}
