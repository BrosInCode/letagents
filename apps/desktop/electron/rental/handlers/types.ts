import type { IpcMain } from "electron";

import type { RentalApiClient } from "../api-client.js";
import type { RenterTriggerRuntime } from "../renter-trigger.js";

export type DisabledRentalResult = {
  enabled: false;
};

export type RentalIpcMain = Pick<IpcMain, "handle">;
export type RentalIpcHandler = (_event: unknown, ...args: unknown[]) => unknown;

export interface DesktopRentalHandlerOptions {
  enabled?: boolean;
  renterTriggerRuntime?: RenterTriggerRuntime;
  /**
   * Optional live API client. When provided, the IPC channels for listings
   * discovery, provider requests, and session lifecycle call the server and
   * surface the mapped DesktopRental* shape. When omitted, channels fall back
   * to stub responses so the UI stays renderable.
   */
  apiClient?: RentalApiClient | null;
}
