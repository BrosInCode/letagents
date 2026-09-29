import type { Express } from "express";

import { isSupervisorHostGrantFeatureEnabled } from "../../shared/agent-session-bearer.js";
import { respondWithInternalError, type AuthenticatedRequest } from "../http/helpers.js";
import { readJevEndpoint } from "../messages/jev-conversation-routing.js";
import { parseCommandReviewInput, reviewCommands } from "../permissions/command-review.js";
import { normalizeRoomId } from "../rooms/routing.js";
import {
  requireCurrentSupervisorGrant,
  respondToStaleSupervisorGrantFence,
  type RoomResolverDeps,
} from "./supervisor-host-grants.js";

export type CommandReviewRouteDeps = RoomResolverDeps & {
  reviewCommands?: typeof reviewCommands;
  requireCurrentSupervisorGrant?: typeof requireCurrentSupervisorGrant;
};

/**
 * A desktop asks whether its own agent's commands may run without asking its
 * owner. Only a current supervisor grant for the agent's room may ask, and
 * the commands are neither stored nor logged.
 */
export function registerCommandReviewRoutes(app: Express, deps: CommandReviewRouteDeps): void {
  if (!isSupervisorHostGrantFeatureEnabled()) return;

  app.post(
    "/supervisor-host-grants/:grantId/command-reviews",
    async (req: AuthenticatedRequest, res) => {
      if (req.authKind !== "supervisor_grant" || req.supervisorGrant?.grant_id !== req.params.grantId) {
        res.status(403).json({ error: "A current supervisor grant is required." });
        return;
      }
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body as Record<string, unknown> : null;
      const { room_id: requestedRoom, ...review } = body ?? {};
      const parsed = parseCommandReviewInput(review);
      if (!parsed || typeof requestedRoom !== "string" || !requestedRoom.trim() || requestedRoom.length > 512) {
        res.status(400).json({ error: "Invalid command review request." });
        return;
      }
      try {
        const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(requestedRoom));
        if (roomId !== requestedRoom) {
          res.status(400).json({ error: "A command review must use the canonical room id.", code: "noncanonical_room_id" });
          return;
        }
        if (!await (deps.requireCurrentSupervisorGrant ?? requireCurrentSupervisorGrant)(req, res, deps, { kind: "rooms", room_ids: [roomId] })) return;
        const result = await (deps.reviewCommands ?? reviewCommands)(parsed, { endpoint: readJevEndpoint() });
        res.setHeader("Cache-Control", "no-store");
        res.json({ decision: result.decision, reason: result.reason });
      } catch (error) {
        if (respondToStaleSupervisorGrantFence(res, error)) return;
        respondWithInternalError(res, "command-review", error, "The commands could not be reviewed.");
      }
    },
  );
}
