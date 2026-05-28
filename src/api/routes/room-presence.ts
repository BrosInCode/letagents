import type { Express } from "express";

import { registerAgentSessionRoutes } from "./room-presence/agent-session-routes.js";
import { registerDisconnectedParticipantRoutes } from "./room-presence/disconnected-routes.js";
import {
  buildRoomActivityHistoryParticipants,
  isSuppressibleDisconnectedPresence,
} from "./room-presence/helpers.js";
import { registerPresenceUpdateRoutes } from "./room-presence/presence-update-routes.js";
import { registerPresenceReadRoutes } from "./room-presence/read-routes.js";
import type { RoomPresenceRouteDeps } from "./room-presence/types.js";

export type { RoomPresenceRouteDeps } from "./room-presence/types.js";
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
