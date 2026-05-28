import type { IpcMain } from "electron";

import type { RentalApiClient } from "../api-client.js";
import type { RenterTriggerRuntime } from "../renter-trigger.js";

export type DisabledRentalResult = {
  enabled: false;
};

export type RentalIpcMain = Pick<IpcMain, "handle">;
export type RentalIpcHandler = (_event: unknown, ...args: unknown[]) => unknown;
export type RentalIpcRegistrar = (
  channel: string,
  handler: RentalIpcHandler,
) => void;

export interface DesktopRentalHandlerOptions {
  enabled?: boolean;
  renterTriggerRuntime?: RenterTriggerRuntime;
  apiClient?: RentalApiClient | null;
}

export interface RentalIpcRegistrationContext {
  apiClient: RentalApiClient | null;
  renterTriggerRuntime: RenterTriggerRuntime;
}

export const disabledRentalResult: DisabledRentalResult = Object.freeze({
  enabled: false,
});
