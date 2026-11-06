import type { Express } from "express";
import { BoardPlanningConflictError, BoardPlanningInputError, validateBoardPlanningUpdate } from "../../../../shared/board-planning.mjs";
import { getBoardPlanning, updateBoardPlanning } from "../../db/board-planning.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { isHumanAppWrite, isSameOriginCookieWrite } from "../../request/app-session.js";
import { resolveGitRoomProjectRole } from "../../rooms/access.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import type { RoomBoardRouteDeps } from "./board.js";

export interface BoardPlanningRouteServices {
  read: typeof getBoardPlanning;
  update: typeof updateBoardPlanning;
  canEdit: (req: AuthenticatedRequest, project: Parameters<RoomBoardRouteDeps["requireParticipant"]>[2]) => Promise<boolean>;
}
const services: BoardPlanningRouteServices = {
  read: getBoardPlanning, update: updateBoardPlanning,
  canEdit: async (req, project) => isHumanAppWrite(req) && !!req.sessionAccount
    && await resolveGitRoomProjectRole(project, req.sessionAccount) === "admin",
};

export function registerBoardPlanningRoutes(app: Express, deps: RoomBoardRouteDeps, service: BoardPlanningRouteServices = services): void {
  const path = /^\/rooms\/(.+)\/board-planning$/;
  app.get(path, async (req: AuthenticatedRequest, res) => {
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(decodeURIComponent((req.params as Record<string, string>)[0] ?? "")));
    const project = await deps.resolveRoomOrReply(roomId, res, { allowCreate: false });
    if (!project || !await deps.requireParticipant(req, res, project)) return;
    res.json(await service.read(project.id, await service.canEdit(req, project)));
  });
  app.patch(path, async (req: AuthenticatedRequest, res) => {
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(decodeURIComponent((req.params as Record<string, string>)[0] ?? "")));
    const project = await deps.resolveRoomOrReply(roomId, res, { allowCreate: false });
    if (!project) return;
    if (!isHumanAppWrite(req, req.body ?? {}) || !isSameOriginCookieWrite(req)) {
      res.status(403).json({ error: "Open board settings from your signed-in LetAgents app." }); return;
    }
    if (!await deps.requireAdmin(req, res, project)) return;
    try {
      const update = validateBoardPlanningUpdate(req.body);
      await service.update(project.id, req.sessionAccount!.login ?? req.sessionAccount!.account_id, update);
      res.json(await service.read(project.id, true));
    } catch (error) {
      if (error instanceof BoardPlanningInputError || error instanceof BoardPlanningConflictError) {
        res.status(error instanceof BoardPlanningConflictError ? 409 : 400).json({ error: error.message }); return;
      }
      throw error;
    }
  });
}
