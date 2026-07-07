import type {
  DesktopRentalActivityEvent,
  DesktopRentalContextApproval,
  DesktopRentalExposure,
  DesktopRentalListing,
  DesktopRentalPatch,
  DesktopRentalRequest,
} from "../../ipc-types.js";

import { mapApiActivityEvent } from "./activity.js";
import { mapApiContextApproval, mapApiExposure } from "./context.js";
import { mapApiListing } from "./listing.js";
import { mapApiPatch } from "./patch.js";
import { isObject } from "./primitives.js";
import { mapApiRequest } from "./request.js";

// ---------------------------------------------------------------------------
// Array helpers
// ---------------------------------------------------------------------------

/**
 * Map an envelope or bare array of API listing rows into desktop
 * shapes. Accepts:
 *   • `[{...}, {...}]`
 *   • `{ listings: [{...}, ...] }`
 */
export function mapApiListingArray(raw: unknown): DesktopRentalListing[] {
  const rows = unwrapArray(raw, "listings");
  return rows
    .map((row) => mapApiListing(row))
    .filter((x): x is DesktopRentalListing => x !== null);
}

export function mapApiRequestArray(raw: unknown): DesktopRentalRequest[] {
  const rows = unwrapArray(raw, "requests");
  return rows
    .map((row) => mapApiRequest(row))
    .filter((x): x is DesktopRentalRequest => x !== null);
}

export function mapApiActivityEventArray(
  raw: unknown,
): DesktopRentalActivityEvent[] {
  const rows = unwrapArray(raw, "events", "activity");
  return rows
    .map((row) => mapApiActivityEvent(row))
    .filter((x): x is DesktopRentalActivityEvent => x !== null);
}

export function mapApiPatchArray(raw: unknown): DesktopRentalPatch[] {
  const rows = unwrapArray(raw, "patches");
  return rows
    .map((row) => mapApiPatch(row))
    .filter((x): x is DesktopRentalPatch => x !== null);
}

export function mapApiExposureArray(raw: unknown): DesktopRentalExposure[] {
  const rows = unwrapArray(raw, "exposures");
  return rows
    .map((row) => mapApiExposure(row))
    .filter((x): x is DesktopRentalExposure => x !== null);
}

export function mapApiContextApprovalArray(
  raw: unknown,
): DesktopRentalContextApproval[] {
  const rows = unwrapArray(raw, "requests", "context_requests");
  return rows
    .map((row) => mapApiContextApproval(row))
    .filter((x): x is DesktopRentalContextApproval => x !== null);
}

function unwrapArray(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isObject(raw)) {
    for (const key of keys) {
      const value = raw[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}
