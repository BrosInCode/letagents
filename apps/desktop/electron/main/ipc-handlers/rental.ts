import type { IpcMain } from "electron";

import { registerDesktopRentalIpcHandlers } from "../../rental-handlers.js";
import { RentalApiClient } from "../../rental/api-client.js";
import { RentalLaunchCoordinator } from "../../rental/launch-coordinator.js";
import {
  RentalProviderEventPoller,
  setActiveRentalProviderEventPoller,
} from "../../rental/provider-event-poller.js";
import {
  RentalProviderHostManager,
  setActiveRentalProviderHostManager,
} from "../../rental/provider-host-manager.js";
import { RenterTriggerRuntime } from "../../rental/renter-trigger.js";
import { runDesktopAgentProviderPreflight } from "../agents/providers.js";
import { getOrCreateDesktopHostId } from "../agents/state.js";
import { readStoredAuth } from "../auth.js";
import { apiUrl } from "../paths.js";
import { emitRoomStreamEvent, getActiveRoomIdentifier } from "../room-stream.js";
import { supervisorDaemonClient } from "../supervisor-daemon.js";
import { emitToMainWindow } from "../window.js";

export function registerDesktopRentalDomainIpcHandlers(targetIpcMain: IpcMain): void {
  const renterTriggerRuntime = new RenterTriggerRuntime({
    getRoomIdentifier: getActiveRoomIdentifier,
    emitRoomStreamEvent,
  });
  // Build the rental API client once at startup. The auth token is
  // resolved on every request via `readStoredAuth()` so sign-in /
  // sign-out cycles take effect without rebuilding the client.
  // Rental failures stay typed and visible; the desktop never fabricates a
  // successful listing, session, or launch when the server is unavailable.
  const rentalApiClient = new RentalApiClient({
    apiBaseUrl: apiUrl,
    async getAuthToken() {
      try {
        const stored = await readStoredAuth();
        return stored.token ?? null;
      } catch {
        return null;
      }
    },
  });
  const rentalLaunchCoordinator = new RentalLaunchCoordinator(rentalApiClient);
  void rentalLaunchCoordinator.recover().catch((error) => {
    console.warn(`Rental launch recovery unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  const rentalProviderEventPoller = new RentalProviderEventPoller(
    rentalApiClient,
    (event) => emitToMainWindow("desktop:rental:provider-event", event),
    async (event) => {
      if (event.kind === "request.cancelled" && event.sessionId) {
        await rentalLaunchCoordinator.teardown(event.sessionId);
      }
    },
  );
  setActiveRentalProviderEventPoller(rentalProviderEventPoller);
  const rentalProviderHostManager = new RentalProviderHostManager(
    rentalApiClient,
    supervisorDaemonClient,
    getOrCreateDesktopHostId,
    runDesktopAgentProviderPreflight,
    async (enabled) => {
      if (enabled) rentalProviderEventPoller.start();
      else await rentalProviderEventPoller.stop();
    },
  );
  setActiveRentalProviderHostManager(rentalProviderHostManager);
  registerDesktopRentalIpcHandlers(targetIpcMain, {
    renterTriggerRuntime,
    apiClient: rentalApiClient,
    launchCoordinator: rentalLaunchCoordinator,
    providerHostManager: rentalProviderHostManager,
  });
}
