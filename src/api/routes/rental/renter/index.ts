/**
 * Renter-facing rental route facade.
 *
 * The public import path stays stable while route groups live under
 * ./rental-renter by API surface.
 */

export { registerRentalRenterRoutes } from "./register.js";
export {
  buildInMemoryListingsRateLimiter,
} from "./rate-limiter.js";
export {
  isRentEnabled,
  isRentalStartTrigger,
  isRentalTriggerConfidence,
  parseTriggerContext,
  RENTAL_START_TRIGGERS,
  RENTAL_TRIGGER_CONFIDENCES,
} from "./validation.js";
export type {
  ListingsRateLimiter,
  ListingsRateLimiterOptions,
} from "./rate-limiter.js";
export type {
  RentalRenterRouteDeps,
} from "./types.js";
export type {
  ParsedTriggerContext,
  RentalStartTrigger,
  RentalTriggerConfidence,
} from "./validation.js";
