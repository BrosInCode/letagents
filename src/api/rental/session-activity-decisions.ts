/**
 * Pure decision helpers for session activity UI projection (p2.10a).
 *
 * Lives in its own module so the test suite can import it without
 * pulling in the DB module. The DB-backed wrapper lives in
 * `session-activity.ts`.
 *
 * See `session-activity.ts` for full doc on the visibility model.
 */

export type SessionActivityRole = "renter" | "provider";

/**
 * Possible `rental_activity_events.visibility` values as stored in
 * the DB (see `rentalVisibilityEnum` in `db/schema.ts`).
 *
 * Note: the desktop's `DesktopRentalActivityVisibility` type uses a
 * superset of strings (e.g. `"both"`) that the api-mapper coerces
 * back to a known value if the server ever returns something else.
 */
export type ActivityVisibility =
  | "rental_visible"
  | "renter_only"
  | "provider_only"
  | "internal";

/**
 * Which `visibility` values does a given role see in the UI?
 * `internal` is always excluded.
 *
 * Per spec §10 the rented agent sees `rental_visible` only. The
 * human-side participants (renter / provider) see their own
 * `*_only` events plus the shared `rental_visible` stream.
 */
export function visibleVisibilitiesFor(role: SessionActivityRole): ActivityVisibility[] {
  if (role === "renter") {
    return ["renter_only", "rental_visible"];
  }
  return ["provider_only", "rental_visible"];
}

/**
 * Clamp a UI-supplied limit into the safe range for activity queries.
 * The route handler accepts an arbitrary `limit` query param; the
 * server keeps it bounded so a malicious caller can't ask for
 * gigabyte-scale activity reads.
 */
export function clampActivityLimit(rawLimit: unknown): number {
  const num = typeof rawLimit === "number" ? rawLimit : Number(rawLimit ?? NaN);
  if (!Number.isFinite(num) || num <= 0) return 200;
  return Math.min(Math.floor(num), 1000);
}
