import type { IpcMain } from "electron";

import {
  listTrackerConnections,
  removeTrackerConnection,
  saveTrackerApiToken,
  startTrackerOAuth,
  testTrackerConnection,
  updateTrackerConnection,
} from "../connectors.js";

/** Ticket connectors: the account's Jira and Linear connections. */
export function registerTicketConnectorIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle("desktop:connectors:list", () => listTrackerConnections());
  targetIpcMain.handle("desktop:connectors:start-oauth", (_event, provider) => startTrackerOAuth(provider));
  targetIpcMain.handle("desktop:connectors:save-api-token", (_event, input) => saveTrackerApiToken(input));
  targetIpcMain.handle("desktop:connectors:test", (_event, id) => testTrackerConnection(id));
  targetIpcMain.handle("desktop:connectors:update", (_event, id, patch) => updateTrackerConnection(id, patch));
  targetIpcMain.handle("desktop:connectors:remove", (_event, id) => removeTrackerConnection(id));
}
