import type { Express } from "express";

import { registerCreateMessageRoute } from "./create-message.js";
import { registerMessageAttachmentRoutes } from "./attachments.js";
import { registerMessageHistoryRoutes } from "./history.js";
import { registerMessageStreamRoute } from "./stream.js";
import type { RoomMessageRouteDeps } from "./types.js";

export type { RoomMessageRouteDeps } from "./types.js";

export function registerRoomMessageRoutes(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  registerCreateMessageRoute(app, deps);
  registerMessageAttachmentRoutes(app, deps);
  registerMessageHistoryRoutes(app, deps);
  registerMessageStreamRoute(app, deps);
}
