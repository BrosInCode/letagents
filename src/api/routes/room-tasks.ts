import type { Express } from "express";

import { registerTaskFocusRoomRoute } from "./room-tasks/focus-room.js";
import { registerTaskGitHubStatusRoute } from "./room-tasks/github-status.js";
import { registerTaskLeaseActionRoute } from "./room-tasks/lease-action.js";
import { registerTaskListAndCreateRoutes } from "./room-tasks/list-and-create.js";
import { registerTaskRecordRoutes } from "./room-tasks/task-record.js";
import { registerTaskReviewLeaseActionRoute } from "./room-tasks/review-lease-action.js";
import { isDesktopHumanTaskWriteForTest } from "./room-tasks/request-identity.js";
import { registerTaskStalePromptRoutes } from "./room-tasks/stale-prompt.js";
import { isCurrentStalePromptAction } from "./room-tasks/task-details.js";
import type { RoomTaskRouteDeps } from "./room-tasks/types.js";

export type { RoomTaskRouteDeps } from "./room-tasks/types.js";
export { isCurrentStalePromptAction, isDesktopHumanTaskWriteForTest };

export function registerRoomTaskRoutes(
  app: Express,
  deps: RoomTaskRouteDeps
): void {
  registerTaskListAndCreateRoutes(app, deps);
  registerTaskFocusRoomRoute(app, deps);
  registerTaskStalePromptRoutes(app, deps);
  registerTaskLeaseActionRoute(app, deps);
  registerTaskReviewLeaseActionRoute(app, deps);
  registerTaskGitHubStatusRoute(app, deps);
  registerTaskRecordRoutes(app, deps);
}
