import { registerRoomTypingRoute } from "./typing.js";
import type { Express } from "express";

import { registerCreateMessageRoute } from "./create-message.js";
import { registerMessageAttachmentRoutes } from "./attachments.js";
import { registerMessageHistoryRoutes } from "./history.js";
import { registerMessageStreamRoute } from "./stream.js";
import { registerMessageInfoRoute } from "./info.js";
import { registerMessageReadsRoute } from "./reads.js";
import { registerMessagePinRoutes } from "./pins.js";
import { registerMessageLinkPreviewRoutes } from "./link-previews.js";
import { registerMessageReactionRoutes } from "./reactions.js";
import { registerMessageSearchRoute } from "./search.js";
import { registerAgentReceiptsRoute } from "./agent-receipts.js";
import { registerAgentObservationRoute } from "../agents/observation.js";
import type { RoomMessageRouteDeps } from "./types.js";

export type { RoomMessageRouteDeps } from "./types.js";

export function registerRoomMessageRoutes(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  registerCreateMessageRoute(app, deps);
  registerMessageLinkPreviewRoutes(app, deps);
  registerMessageAttachmentRoutes(app, deps);
  registerMessageHistoryRoutes(app, deps);
  registerMessageStreamRoute(app, deps);
  registerMessageInfoRoute(app, deps);
  registerMessageReadsRoute(app, deps);
  registerMessageReactionRoutes(app, deps);
  registerMessageSearchRoute(app, deps);
  registerMessagePinRoutes(app, deps);
  registerAgentReceiptsRoute(app, deps);
  registerAgentObservationRoute(app, deps);
  registerRoomTypingRoute(app, deps);
}
