import { RenterTriggerRuntime } from "../renter-trigger.js";
import { registerActivityHandlers } from "./activity.js";
import { registerListingHandlers } from "./listings.js";
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
  const configured = process.env.LETAGENTS_RENT_ENABLED?.trim();

  // Rent an Agent ships as a first-class desktop surface. Packaged apps do not
  // inherit the production server's environment, so requiring an opt-in here
  // left the built UI permanently disabled for normal desktop launches.
  // Keep an explicit false value as an emergency/local kill switch.
  if (!configured) return true;
  return /^(1|true|yes|on)$/i.test(configured);
}

export function registerDesktopRentalIpcHandlers(
  ipcMain: RentalIpcMain,
  options: DesktopRentalHandlerOptions = {},
): void {
  const enabled = options.enabled ?? isRentEnabled();
  const context: RentalIpcRegistrationContext = {
    renterTriggerRuntime: options.renterTriggerRuntime ?? new RenterTriggerRuntime(),
    apiClient: options.apiClient ?? null,
  };

  const register = (channel: string, handler: RentalIpcHandler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!enabled) return disabledRentalResult;
      return handler(event, ...args);
    });
  };

  registerListingHandlers(register, context);
  registerSessionHandlers(register, context);
  registerActivityHandlers(register, context);
  registerQuotaHandlers(register, context);
}
