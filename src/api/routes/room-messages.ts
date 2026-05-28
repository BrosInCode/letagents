import type { Express } from "express";

import { registerCreateMessageRoute } from "./room-messages/create-message.js";
import { registerMessageAttachmentRoutes } from "./room-messages/attachments.js";
import { registerMessageHistoryRoutes } from "./room-messages/history.js";
import { registerMessageStreamRoute } from "./room-messages/stream.js";
import type { RoomMessageRouteDeps } from "./room-messages/types.js";

export type { RoomMessageRouteDeps } from "./room-messages/types.js";

export function registerRoomMessageRoutes(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  registerCreateMessageRoute(app, deps);
  registerMessageAttachmentRoutes(app, deps);
  registerMessageHistoryRoutes(app, deps);
  registerMessageStreamRoute(app, deps);
}
