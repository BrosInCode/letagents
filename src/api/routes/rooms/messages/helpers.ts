import type { Response } from "express";

import type { Project } from "../../../db.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { resolveRoomRequest } from "../../../rooms/request-room.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import type { RoomMessageRouteDeps } from "./types.js";

export function routeParam(req: AuthenticatedRequest, index: number): string {
  const params = req.params as Record<string, string>;
  const val = params[index] ?? (index === 0 ? params.room : index === 1 ? params.message : undefined) ?? "";
  return decodeURIComponent(val);
}

/** What `resolveParticipantRoom` needs; route deps types that call it must carry all of it. */
export type ParticipantRoomDeps = Pick<
  RoomMessageRouteDeps,
  "resolveCanonicalRoomRequestId" | "resolveRoomRequestOrReply" | "resolveRoomOrReply" | "requireParticipant"
>;

export async function resolveParticipantRoom(
  req: AuthenticatedRequest,
  res: Response,
  deps: ParticipantRoomDeps
): Promise<Project | null> {
  const { project } = await resolveRoomRequest(deps, normalizeRoomId(routeParam(req, 0)), res);
  if (!project) return null;

  if (!(await deps.requireParticipant(req, res, project))) return null;
  return project;
}
