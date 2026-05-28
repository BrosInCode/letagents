/**
 * Internal rental routes — called by adapters / MCP tools, not browsers.
 *
 * Routes are mounted under /api/rental. See the modules in
 * ./rental-internal/ for usage/budget, heartbeat/quota, context,
 * patch/command, and lifecycle route groups.
 */

import type { Express } from "express";

import { registerActivityLifecycleRoutes } from "./rental-internal/activity-lifecycle-routes.js";
import { registerContextToolRoutes } from "./rental-internal/context-tool-routes.js";
import { defaultRentalInternalDeps } from "./rental-internal/deps.js";
import { registerHeartbeatQuotaRoutes } from "./rental-internal/heartbeat-quota-routes.js";
import { registerPatchCommandRoutes } from "./rental-internal/patch-command-routes.js";
import type { RentalInternalRouteDeps } from "./rental-internal/types.js";
import { registerUsageBudgetRoutes } from "./rental-internal/usage-budget-routes.js";

export { defaultRentalInternalDeps } from "./rental-internal/deps.js";
export { isRentEnabled } from "./rental-internal/validation.js";
export type { RentalInternalRouteDeps } from "./rental-internal/types.js";

export function registerRentalInternalRoutes(
  app: Express,
  deps: RentalInternalRouteDeps = defaultRentalInternalDeps,
): void {
  registerUsageBudgetRoutes(app, deps);
  registerHeartbeatQuotaRoutes(app, deps);
  registerContextToolRoutes(app, deps);
  registerPatchCommandRoutes(app, deps);
  registerActivityLifecycleRoutes(app, deps);
}
