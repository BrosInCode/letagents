import type { IpcMain } from "electron";

import {
  cancelTrackerOAuth,
  connectTrackerWithOAuth,
  getTrackerWebhookSetup,
  listTrackerConnections,
  removeTrackerConnection,
  saveTrackerApiToken,
  testTrackerConnection,
  updateTrackerConnection,
} from "../connectors.js";
import {
  getDesktopRoomTaskTicket,
  listDesktopRoomTrackerFilters,
  removeDesktopRoomTrackerFilter,
  saveDesktopRoomTrackerFilter,
  setDesktopRoomTrackerFilterEnabled,
  testDesktopRoomTrackerFilter,
} from "../rooms/tracker-filters.js";

/** Ticket connectors: the account's Jira and Linear connections, and room ticket filters. */
export function registerTicketConnectorIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle("desktop:connectors:list", () => listTrackerConnections());
  targetIpcMain.handle("desktop:connectors:connect-oauth", (_event, provider) => connectTrackerWithOAuth(provider));
  targetIpcMain.handle("desktop:connectors:cancel-oauth", () => cancelTrackerOAuth());
  targetIpcMain.handle("desktop:connectors:save-api-token", (_event, input) => saveTrackerApiToken(input));
  targetIpcMain.handle("desktop:connectors:test", (_event, id) => testTrackerConnection(id));
  targetIpcMain.handle("desktop:connectors:update", (_event, id, patch) => updateTrackerConnection(id, patch));
  targetIpcMain.handle("desktop:connectors:remove", (_event, id) => removeTrackerConnection(id));
  targetIpcMain.handle("desktop:connectors:webhook", (_event, id) => getTrackerWebhookSetup(id));
  targetIpcMain.handle("desktop:room:get-task-ticket", (_event, roomIdentifier, taskId) => getDesktopRoomTaskTicket(roomIdentifier, taskId));
  targetIpcMain.handle("desktop:room:list-tracker-filters", (_event, roomIdentifier) => listDesktopRoomTrackerFilters(roomIdentifier));
  targetIpcMain.handle("desktop:room:save-tracker-filter", (_event, roomIdentifier, input) => saveDesktopRoomTrackerFilter(roomIdentifier, input));
  targetIpcMain.handle("desktop:room:set-tracker-filter-enabled", (_event, roomIdentifier, id, enabled) =>
    setDesktopRoomTrackerFilterEnabled(roomIdentifier, id, enabled));
  targetIpcMain.handle("desktop:room:remove-tracker-filter", (_event, roomIdentifier, id) => removeDesktopRoomTrackerFilter(roomIdentifier, id));
  targetIpcMain.handle("desktop:room:test-tracker-filter", (_event, roomIdentifier, input) => testDesktopRoomTrackerFilter(roomIdentifier, input));
}
