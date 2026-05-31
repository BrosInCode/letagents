import type { Express } from "express";

import { registerAgentSessionRoutes } from "./agent-session-routes.js";
import { registerDisconnectedParticipantRoutes } from "./disconnected-routes.js";
import {
  buildRoomActivityHistoryParticipants,
  isSuppressibleDisconnectedPresence,
} from "./helpers.js";
import { registerPresenceUpdateRoutes } from "./presence-update-routes.js";
import { registerPresenceReadRoutes } from "./read-routes.js";
import type { RoomPresenceRouteDeps } from "./types.js";

export type { RoomPresenceRouteDeps } from "./types.js";
export {
  buildRoomActivityHistoryParticipants,
  isSuppressibleDisconnectedPresence,
};

export function registerRoomPresenceRoutes(
  app: Express,
  deps: RoomPresenceRouteDeps
): void {
  registerPresenceReadRoutes(app, deps);
  registerDisconnectedParticipantRoutes(app, deps);
  registerAgentSessionRoutes(app, deps);
  registerPresenceUpdateRoutes(app, deps);
}
