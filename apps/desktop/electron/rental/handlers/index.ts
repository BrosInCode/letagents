import { RenterTriggerRuntime } from "../renter-trigger.js";
import { registerActivityHandlers } from "./activity.js";
import { registerListingHandlers } from "./listings.js";
import { registerMarketplaceHandlers } from "./marketplace.js";
import { registerQuotaHandlers } from "./quota.js";
import { registerSessionHandlers } from "./sessions.js";
import {
  disabledRentalResult,
  type DesktopRentalHandlerOptions,
  type RentalIpcHandler,
  type RentalIpcMain,
  type RentalIpcRegistrationContext,
} from "./types.js";

export type {
  DesktopRentalHandlerOptions,
  DisabledRentalResult,
} from "./types.js";

export function isRentEnabled(): boolean {
  // Rollout authority belongs to the server. Packaged desktop processes do
  // not inherit server environment variables, so a local flag can only create
  // a split-brain UI that is enabled in production and disabled on the Mac.
  return true;
}

export function registerDesktopRentalIpcHandlers(
  ipcMain: RentalIpcMain,
  options: DesktopRentalHandlerOptions = {},
): void {
  const enabled = options.enabled ?? isRentEnabled();
  const context: RentalIpcRegistrationContext = {
    renterTriggerRuntime: options.renterTriggerRuntime ?? new RenterTriggerRuntime(),
    apiClient: options.apiClient ?? null,
    launchCoordinator: options.launchCoordinator ?? null,
    providerHostManager: options.providerHostManager ?? null,
  };

  const register = (channel: string, handler: RentalIpcHandler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!enabled) return disabledRentalResult;
      return handler(event, ...args);
    });
  };

  registerListingHandlers(register, context);
  registerMarketplaceHandlers(register, context);
  registerSessionHandlers(register, context);
  registerActivityHandlers(register, context);
  registerQuotaHandlers(register, context);
}
