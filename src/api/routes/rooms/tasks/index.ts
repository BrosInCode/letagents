import type { Express } from "express";

import { registerTaskFocusRoomRoute } from "./focus-room.js";
import { registerTaskGitHubStatusRoute } from "./github-status.js";
import { registerTaskLeaseActionRoute } from "./lease-action.js";
import { registerTaskListAndCreateRoutes } from "./list-and-create.js";
import { registerTaskRecordRoutes } from "./task-record.js";
import { registerTaskReviewLeaseActionRoute } from "./review-lease-action.js";
import { registerTaskReviewVerdictRoute } from "./review-verdict.js";
import { isDesktopHumanTaskWriteForTest } from "./request-identity.js";
import { registerTaskStalePromptRoutes } from "./stale-prompt.js";
import { getTaskBoardStalePromptState, isCurrentStalePromptAction } from "./task-details.js";
import type { RoomTaskRouteDeps } from "./types.js";

export type { RoomTaskRouteDeps } from "./types.js";
export { getTaskBoardStalePromptState, isCurrentStalePromptAction, isDesktopHumanTaskWriteForTest };

export function registerRoomTaskRoutes(
  app: Express,
  deps: RoomTaskRouteDeps
): void {
  registerTaskListAndCreateRoutes(app, deps);
  registerTaskFocusRoomRoute(app, deps);
  registerTaskStalePromptRoutes(app, deps);
  registerTaskLeaseActionRoute(app, deps);
  registerTaskReviewLeaseActionRoute(app, deps);
  registerTaskReviewVerdictRoute(app, deps);
  registerTaskGitHubStatusRoute(app, deps);
  registerTaskRecordRoutes(app, deps);
}
