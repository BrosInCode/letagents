import type { Express, Response } from "express";

import {
  getGitHubRoomEvents,
  type Project,
} from "../db.js";
import {
  parseLimit,
  type AuthenticatedRequest,
} from "../http-helpers.js";
import { normalizeRoomId } from "../room-routing.js";

export interface RoomEventRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  getProjectAccessRoomId(project: Project): string;
}

export function registerRoomEventRoutes(
  app: Express,
  deps: RoomEventRouteDeps
): void {
  app.get(/^(?:\/api)?\/rooms\/(.+)\/events$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const event_type = typeof req.query.event_type === "string" ? req.query.event_type : undefined;
    const github_object_id = typeof req.query.object_id === "string" ? req.query.object_id : undefined;
    const actor_login = typeof req.query.actor === "string" ? req.query.actor : undefined;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const until = typeof req.query.until === "string" ? req.query.until : undefined;
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);

    const githubRoomId = deps.getProjectAccessRoomId(project);
    const result = await getGitHubRoomEvents({
      room_id: githubRoomId,
      event_type,
      github_object_id,
      actor_login,
      since,
      until,
      after,
      limit,
    });

    res.json({
      room_id: project.id,
      github_room_id: githubRoomId,
      events: result.events.map((event) => ({
        id: event.id,
        event_type: event.event_type,
        action: event.action,
        github_object_id: event.github_object_id,
        github_object_url: event.github_object_url,
        title: event.title,
        state: event.state,
        actor_login: event.actor_login,
        metadata: event.metadata,
        linked_task_id: event.linked_task_id,
        created_at: event.created_at,
      })),
      has_more: result.has_more,
    });
  });
}
