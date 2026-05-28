/**
 * Renter-facing rental route facade.
 *
 * The public import path stays stable while route groups live under
 * ./rental-renter by API surface.
 */

export { registerRentalRenterRoutes } from "./rental-renter/register.js";
export {
  buildInMemoryListingsRateLimiter,
} from "./rental-renter/rate-limiter.js";
export {
  isRentEnabled,
  isRentalStartTrigger,
  isRentalTriggerConfidence,
  parseTriggerContext,
  RENTAL_START_TRIGGERS,
  RENTAL_TRIGGER_CONFIDENCES,
} from "./rental-renter/validation.js";
export type {
  ListingsRateLimiter,
  ListingsRateLimiterOptions,
} from "./rental-renter/rate-limiter.js";
export type {
  RentalRenterRouteDeps,
} from "./rental-renter/types.js";
export type {
  ParsedTriggerContext,
  RentalStartTrigger,
  RentalTriggerConfidence,
} from "./rental-renter/validation.js";
