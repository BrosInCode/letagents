import type { Express, Response } from "express";
import type { RoomCompanyAppearance } from "../../../../shared/room-themes.mjs";

import {
  type GitRoomBinding,
  type Project,
} from "../../db.js";
import {
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../../http/helpers.js";
import type { RoomRequestResolver } from "../../rooms/request-room.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import { getProjectAccessRoomId } from "../../rooms/access-decision.js";
import { isAppSession } from "../../request/app-session.js";

type RoomRole = "admin" | "participant" | "anonymous";

export interface RoomMetadataRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  /** Both room resolvers in one statement where it can; see `resolveRoomRequest`. */
  resolveRoomRequestOrReply: RoomRequestResolver;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  updateProjectDisplayName(projectId: string, displayName: string): Promise<Project | null>;
  resolveProjectRole(
    project: Project,
    sessionAccount: AuthenticatedRequest["sessionAccount"]
  ): Promise<RoomRole>;
  getGitRoomBindingForRoom?(roomId: string): Promise<GitRoomBinding | null>;
  getRoomCompanyAppearance?(roomId: string, accessRoomId: string, repositoryId: string | null): Promise<RoomCompanyAppearance | null>;
  toRoomResponse(
    project: Project,
    options?: {
      role?: RoomRole;
      authenticated?: boolean;
      gitRoomBinding?: GitRoomBinding | null;
    }
  ): Record<string, unknown>;
}

export function registerRoomMetadataRoutes(
  app: Express,
  deps: RoomMetadataRouteDeps
): void {
  app.patch(/^\/rooms\/(.+)$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireAdmin(req, res, project))) return;

    const { display_name } = req.body as { display_name?: string };
    if (!display_name?.trim()) {
      res.status(400).json({ error: "display_name is required" });
      return;
    }

    try {
      const gitRoomBinding = await deps.getGitRoomBindingForRoom?.(project.id);
      let companyAppearance: RoomCompanyAppearance | null = null;
      if (isAppSession(req) && deps.getRoomCompanyAppearance) {
        const accessRoomId = getProjectAccessRoomId(project);
        const appearanceBinding = gitRoomBinding ?? (accessRoomId !== project.id
          ? await deps.getGitRoomBindingForRoom?.(accessRoomId)
          : null);
        companyAppearance = await deps.getRoomCompanyAppearance(project.id, accessRoomId, appearanceBinding?.repository_id ?? null);
      }
      const updated = await deps.updateProjectDisplayName(project.id, display_name);
      if (!updated) {
        res.status(404).json({ error: "Room not found" });
        return;
      }

      const role = await deps.resolveProjectRole(updated, req.sessionAccount);
      res.json({
        ...(companyAppearance ? { company_appearance: companyAppearance } : {}),
        ...deps.toRoomResponse(updated, {
          role,
          authenticated: Boolean(req.sessionAccount),
          ...(gitRoomBinding !== undefined ? { gitRoomBinding } : {}),
        }),
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "PATCH /rooms/:room_id",
        error,
        "Room update could not be completed."
      );
    }
  });
}
