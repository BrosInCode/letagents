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
  return /^(1|true|yes)$/i.test(
    process.env.LETAGENTS_RENT_ENABLED?.trim() ?? "",
  );
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
