import type { IpcMain } from "electron";

import type { RentalApiClient } from "../api-client.js";
import type { RentalLaunchCoordinator } from "../launch-coordinator.js";
import type { RentalProviderHostManager } from "../provider-host-manager.js";
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
  launchCoordinator?: RentalLaunchCoordinator | null;
  providerHostManager?: RentalProviderHostManager | null;
}

export interface RentalIpcRegistrationContext {
  apiClient: RentalApiClient | null;
  renterTriggerRuntime: RenterTriggerRuntime;
  launchCoordinator: RentalLaunchCoordinator | null;
  providerHostManager: RentalProviderHostManager | null;
}

export class RentalServiceError extends Error {
  constructor(
    readonly code: "unavailable" | "invalid_response" | "request_failed",
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "RentalServiceError";
  }
}

export function rentalApiUnavailable(operation: string): never {
  throw new RentalServiceError("unavailable", `${operation} is unavailable because the rental service is not connected.`);
}

export function rentalApiFailure(operation: string, result: { status: number; error: string }): never {
  throw new RentalServiceError("request_failed", `${operation} failed (${result.error}).`, result.status);
}

export function rentalInvalidResponse(operation: string): never {
  throw new RentalServiceError("invalid_response", `${operation} returned an invalid response.`);
}

export const disabledRentalResult: DisabledRentalResult = Object.freeze({
  enabled: false,
});
