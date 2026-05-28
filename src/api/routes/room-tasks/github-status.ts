import type { Express } from "express";

import {
  getTasksGitHubArtifactStatus,
  type TaskGitHubArtifactStatus,
} from "../../db.js";
import type { AuthenticatedRequest } from "../../http-helpers.js";
import { normalizeRoomId } from "../../room-routing.js";
import type { RoomTaskRouteDeps } from "./types.js";

export function registerTaskGitHubStatusRoute(
  app: Express,
  deps: RoomTaskRouteDeps
): void {
  /**
   * GET /rooms/:room/tasks/github-status
   * Returns GitHub artifact status for all tasks in a room that have linked events.
   */
  app.get(/^(?:\/api)?\/rooms\/(.+)\/tasks\/github-status$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const statusMap = await getTasksGitHubArtifactStatus(project.id);

    const statuses: Record<string, TaskGitHubArtifactStatus> = {};
    for (const [taskId, status] of statusMap) {
      statuses[taskId] = status;
    }

    res.json({
      room_id: project.id,
      statuses,
    });
  });
}
