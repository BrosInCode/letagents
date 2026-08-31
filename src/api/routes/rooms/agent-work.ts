import type { Express } from "express";
import { isSupervisorHostGrantFeatureEnabled } from "../../../shared/agent-session-bearer.js";
import { publishRoomAgentWork, readRoomAgentWork, RoomAgentWorkError } from "../../db/room-agent-work.js";
import { respondWithInternalError, type AuthenticatedRequest } from "../../http/helpers.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import { requireCurrentSupervisorGrant, respondToStaleSupervisorGrantFence, type RoomResolverDeps } from "../supervisor-host-grants.js";
import { resolveParticipantRoom, routeParam } from "./messages/helpers.js";
import type { RoomMessageRouteDeps } from "./messages/types.js";

export function registerRoomAgentWorkRoutes(app: Express, roomDeps: RoomMessageRouteDeps, supervisorDeps: RoomResolverDeps): void {
  // Reads remain available when grant rollout is disabled. These are retained
  // host reports, not current liveness; no events or polling cursors yet.
  app.get(/^\/rooms\/(.+)\/agent-work(?:\/([^/]+))?$/, async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount?.account_id || (req.authKind !== "session" && req.authKind !== "owner_token")) {
      res.status(401).json({ error: "Room work history requires human account authentication." }); return;
    }
    const room = await resolveParticipantRoom(req, res, roomDeps);
    if (!room) return;
    const attemptId = routeParam(req, 1);
    if (attemptId && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attemptId)) {
      res.status(404).json({ error: "Work evidence is not available in this room." }); return;
    }
    try {
      const result = await readRoomAgentWork({ room_id: room.id, ...(attemptId ? { attempt_id: attemptId } : {}) });
      if (attemptId && result.work.length === 0) {
        res.status(404).json({ error: "Work evidence is not available in this room." }); return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(attemptId ? result.work[0] : result);
    } catch (error) { respondWithInternalError(res, "room-agent-work.read", error, "Could not read room work evidence."); }
  });

  if (!isSupervisorHostGrantFeatureEnabled()) return;
  app.post("/supervisor-host-grants/:grantId/worker-sessions/:sessionId/agent-work", async (req: AuthenticatedRequest, res) => {
    if (req.authKind !== "supervisor_grant" || req.supervisorGrant?.grant_id !== req.params.grantId) {
      res.status(403).json({ error: "A current supervisor grant is required." }); return;
    }
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["room_id", "source_message_id", "revision", "summary", "generation"].includes(key))
      || typeof body.room_id !== "string" || body.room_id.length > 512 || !body.room_id.trim()
      || typeof body.source_message_id !== "string" || !/^msg_[1-9]\d{0,9}$/.test(body.source_message_id)
      || Number(body.source_message_id.slice(4)) > 2147483647) {
      res.status(400).json({ error: "Invalid room work snapshot." }); return;
    }
    try {
      const roomId = await supervisorDeps.resolveCanonicalRoomRequestId(normalizeRoomId(body.room_id));
      const grant = await requireCurrentSupervisorGrant(req, res, supervisorDeps, { kind: "rooms", room_ids: [roomId] });
      if (!grant) return;
      const result = await publishRoomAgentWork({
        fence: { grant_id: grant.grant_id, generation: grant.current_generation, token_version: grant.token_version },
        room_id: roomId, session_id: String(req.params.sessionId), source_message_number: Number(body.source_message_id.slice(4)),
        revision: body.revision as number, summary: body.summary,
      });
      res.status(result.status === "created" ? 201 : 200).json(result);
    } catch (error) {
      if (respondToStaleSupervisorGrantFence(res, error)) return;
      if (error instanceof RoomAgentWorkError) {
        res.status(error.code === "invalid_summary" ? 400 : error.code === "publisher_not_authorized" ? 403 : 409)
          .json({ error: "Room work snapshot was not accepted.", code: error.code }); return;
      }
      respondWithInternalError(res, "room-agent-work.publish", error, "Could not store room work evidence.");
    }
  });
}
