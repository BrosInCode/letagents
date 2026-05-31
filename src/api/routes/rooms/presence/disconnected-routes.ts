import type { Express } from "express";

import {
  getRoomAgentPresenceSnapshot,
  getRoomParticipantsForRooms,
  setRoomLiveAgentSuppressed,
  setRoomParticipantsHidden,
} from "../../../db.js";
import {
  respondWithInternalError,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import {
  isSuppressibleDisconnectedPresence,
  normalizeActorLabel,
} from "./helpers.js";
import type { RoomPresenceRouteDeps } from "./types.js";

export function registerDisconnectedParticipantRoutes(
  app: Express,
  deps: RoomPresenceRouteDeps
): void {
  app.post(/^\/rooms\/(.+)\/participants\/(?:clear|archive)-disconnected$/, async (req: AuthenticatedRequest, res) => {
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
          .filter((entry) =>
            entry.session_kind === "worker"
            && entry.freshness === "active"
            && entry.source_flags.includes("delivery")
          )
          .map((entry) => normalizeActorLabel(entry.actor_label))
          .filter(Boolean)
      );
      const hiddenParticipantKeys = participants
        .filter((participant) =>
          participant.kind === "agent"
          && !participant.hidden_at
          && !activeActors.has(normalizeActorLabel(participant.actor_label))
        )
        .map((participant) => participant.participant_key);
      const suppressedActorLabels = Array.from(new Set(
        presence
          .filter((entry) => isSuppressibleDisconnectedPresence(entry))
          .map((entry) => normalizeActorLabel(entry.actor_label))
          .filter(Boolean)
      ));
      const [hiddenParticipantCount, suppressedCount] = await Promise.all([
        setRoomParticipantsHidden({
          room_id: project.id,
          participant_keys: hiddenParticipantKeys,
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
        cleared_count: hiddenParticipantCount + suppressedCount,
        participant_hidden_count: hiddenParticipantCount,
        suppressed_count: suppressedCount,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "POST /rooms/:room_id/participants/clear-disconnected",
        error,
        "Disconnected participants could not be cleared from the live roster."
      );
    }
  });
}
