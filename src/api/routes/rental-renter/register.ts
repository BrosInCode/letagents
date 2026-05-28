import type { Express } from "express";
import type { RentalRenterRouteDeps } from "./types.js";
import { registerBudgetExtensionRoutes } from "./budget-extension-routes.js";
import { registerMarketplaceRoutes } from "./marketplace-routes.js";
import { registerPatchRoutes } from "./patch-routes.js";
import { registerRenterQuotaRoutes } from "./quota-routes.js";
import { registerSessionRoutes } from "./session-routes.js";

export function registerRentalRenterRoutes(
  app: Express,
  deps: RentalRenterRouteDeps,
): void {
  registerMarketplaceRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerPatchRoutes(app, deps);
  registerRenterQuotaRoutes(app, deps);
  registerBudgetExtensionRoutes(app, deps);
}
