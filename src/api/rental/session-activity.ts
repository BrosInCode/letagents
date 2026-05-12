/**
 * Session activity read service (p2.10a).
 *
 * Renter/provider-facing read of `rental_activity_events` for a
 * single rental session. The desktop session-detail modal (p5.4)
 * calls this via `desktop:rental:get-activity` to render the
 * "Activity" tab in the session-detail dialog.
 *
 * Distinct from `projectActivityForRental` in `room-projection.ts`,
 * which is the *rented agent's* view (rental_visible only, ordered
 * ascending, capped low). The UI view exposed here is for the two
 * human-side participants and uses role-based visibility filtering
 * (see `session-activity-decisions.ts`).
 *
 * The DB query is intentionally simple (no joins, no payload
 * filtering). Verification + visibility are pre-baked when the
 * event is emitted (see `activity-emitter.ts`).
 *
 * Spec refs: §10 (room projection / rental view), §19 (activity
 * event schema), §22 (session-detail UI surface).
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { rental_activity_events } from "../db/schema.js";
import {
  clampActivityLimit,
  visibleVisibilitiesFor,
  type SessionActivityRole,
} from "./session-activity-decisions.js";

export type {
  ActivityVisibility,
  SessionActivityRole,
} from "./session-activity-decisions.js";
export { visibleVisibilitiesFor } from "./session-activity-decisions.js";

export interface ListSessionActivityOptions {
  /** Caller's role on this session. */
  role: SessionActivityRole;
  /** Max events to return. Defaults to 200. Capped at 1000. */
  limit?: number;
  /** When true, only verified events are returned. Defaults to false. */
  verifiedOnly?: boolean;
}

export type SessionActivityRow = typeof rental_activity_events.$inferSelect;

/**
 * Fetch the activity events visible to `opts.role` for `sessionId`,
 * newest-first. Caller is responsible for confirming the requester
 * owns the session (use `getSessionById(sessionId, accountId)` first
 * — the dep wiring in `rental-renter.ts` does this).
 */
export async function listSessionActivityForUi(
  sessionId: string,
  opts: ListSessionActivityOptions,
): Promise<SessionActivityRow[]> {
  const limit = clampActivityLimit(opts.limit);
  const visibilities = visibleVisibilitiesFor(opts.role);

  const conditions = [
    eq(rental_activity_events.session_id, sessionId),
    inArray(rental_activity_events.visibility, visibilities),
  ];
  if (opts.verifiedOnly) {
    conditions.push(eq(rental_activity_events.verified, true));
  }

  return db
    .select()
    .from(rental_activity_events)
    .where(and(...conditions))
    .orderBy(desc(rental_activity_events.created_at))
    .limit(limit);
}
