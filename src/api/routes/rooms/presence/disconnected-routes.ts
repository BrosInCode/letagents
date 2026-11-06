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
  deps: RoomPresenceRouteDeps,
  store = { getRoomAgentPresenceSnapshot, getRoomParticipantsForRooms, setRoomParticipantsHidden, setRoomLiveAgentSuppressed },
): void {
  // A distinct selected route prevents older servers from treating a selection
  // as the legacy, room-wide cleanup request.
  app.post(/^\/rooms\/(.+)\/participants\/((?:clear|archive)-disconnected|archive-selected)$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireAdmin(req, res, project))) return;

    const selected = (req.params as Record<string, string>)[1] === "archive-selected";
    const keys: unknown = req.body?.participant_keys;
    if (selected && (!Array.isArray(keys) || keys.length === 0 || keys.length > 500
      || keys.some(key => typeof key !== "string" || !key.trim() || key.length > 1000))) {
      res.status(400).json({ error: "Choose between 1 and 500 agent participants to archive." });
      return;
    }
    const selection = selected ? new Set(keys as string[]) : null;
    try {
      const [participants, presence] = await Promise.all([
        store.getRoomParticipantsForRooms([project.id], { includeHidden: true }),
        store.getRoomAgentPresenceSnapshot(project.id),
      ]);
      const activePresence = presence.filter(entry => entry.session_kind === "worker" && entry.freshness === "active"
        && (selected || entry.source_flags.includes("delivery")));
      const activeActors = new Set(
        activePresence
          .map((entry) => normalizeActorLabel(entry.actor_label))
          .filter(Boolean)
      );
      const activeKeys = new Set(activePresence.map(entry => entry.agent_key).filter(Boolean));
      const candidates = participants
        .filter((participant) =>
          participant.kind === "agent"
          && (!selection || selection.has(participant.participant_key))
          && (!selected || !participant.agent_key || !activeKeys.has(participant.agent_key))
          && !activeActors.has(normalizeActorLabel(participant.actor_label))
        );
      const hiddenParticipantKeys = candidates.filter(participant => !participant.hidden_at)
        .map((participant) => participant.participant_key);
      const selectedActors = new Set(candidates.map(participant => normalizeActorLabel(participant.actor_label)));
      const suppressedActorLabels = Array.from(new Set(
        presence
          .filter((entry) => isSuppressibleDisconnectedPresence(entry)
            && (!selection || selectedActors.has(normalizeActorLabel(entry.actor_label))))
          .map((entry) => normalizeActorLabel(entry.actor_label))
          .filter(Boolean)
      ));
      const [hiddenParticipantCount, suppressedCount] = await Promise.all([
        store.setRoomParticipantsHidden({
          room_id: project.id,
          participant_keys: hiddenParticipantKeys,
          hidden: true,
          hidden_by: req.sessionAccount?.login ?? "room-admin",
        }),
        store.setRoomLiveAgentSuppressed({
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
        ...(selection ? {
          archived_participant_keys: candidates.map(participant => participant.participant_key),
          skipped_participant_keys: [...selection].filter(key => !candidates.some(participant => participant.participant_key === key)),
        } : {}),
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
