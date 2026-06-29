import type { Express, Response } from "express";

import {
  type GitRoomBinding,
  type Project,
} from "../../db.js";
import {
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../../http/helpers.js";
import { normalizeRoomId } from "../../rooms/routing.js";

type RoomRole = "admin" | "participant" | "anonymous";

export interface RoomMetadataRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
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
      const updated = await deps.updateProjectDisplayName(project.id, display_name);
      if (!updated) {
        res.status(404).json({ error: "Room not found" });
        return;
      }

      const role = await deps.resolveProjectRole(updated, req.sessionAccount);
      const gitRoomBinding = deps.getGitRoomBindingForRoom
        ? await deps.getGitRoomBindingForRoom(updated.id)
        : undefined;
      res.json({
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
