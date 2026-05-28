import type { Response } from "express";

import type { Project } from "../../db.js";
import type { AuthenticatedRequest } from "../../http-helpers.js";
import { normalizeRoomId } from "../../room-routing.js";
import type { RoomMessageRouteDeps } from "./types.js";

export function routeParam(req: AuthenticatedRequest, index: number): string {
  return decodeURIComponent((req.params as Record<string, string>)[index] ?? "");
}

export async function resolveParticipantRoom(
  req: AuthenticatedRequest,
  res: Response,
  deps: RoomMessageRouteDeps
): Promise<Project | null> {
  const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(routeParam(req, 0)));
  const project = await deps.resolveRoomOrReply(roomId, res);
  if (!project) return null;

  if (!(await deps.requireParticipant(req, res, project))) return null;
  return project;
}
