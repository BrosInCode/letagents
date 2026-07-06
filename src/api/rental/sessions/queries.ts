import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { rental_sessions } from "../../db/schema.js";

/**
 * Session statuses that consume a slot against a listing's
 * max_concurrent_sessions. "requested" is excluded (the provider has not
 * committed capacity yet), as are the terminal states.
 */
export const CAPACITY_CONSUMING_STATUSES = [
  "accepted",
  "provisioning",
  "active",
  "blocked",
  "patch_review",
  "pr_opened",
  "budget_exhausted",
  "stale",
] as const;

export async function countCapacityConsumingSessions(
  listingId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rental_sessions)
    .where(
      and(
        eq(rental_sessions.listing_id, listingId),
        inArray(rental_sessions.status, [...CAPACITY_CONSUMING_STATUSES]),
      ),
    );
  return row?.count ?? 0;
}

export async function getSessionById(
  sessionId: string,
  accountId: string,
): Promise<typeof rental_sessions.$inferSelect | null> {
  const [session] = await db
    .select()
    .from(rental_sessions)
    .where(eq(rental_sessions.id, sessionId));

  if (!session) return null;

  if (
    session.renter_account_id !== accountId &&
    session.provider_account_id !== accountId
  ) {
    return null;
  }

  return session;
}

export async function listProviderRequests(
  providerAccountId: string,
): Promise<(typeof rental_sessions.$inferSelect)[]> {
  return db
    .select()
    .from(rental_sessions)
    .where(
      and(
        eq(rental_sessions.provider_account_id, providerAccountId),
        eq(rental_sessions.status, "requested"),
      ),
    )
    .orderBy(desc(rental_sessions.created_at));
}

export async function listRenterSessions(
  renterAccountId: string,
): Promise<(typeof rental_sessions.$inferSelect)[]> {
  return db
    .select()
    .from(rental_sessions)
    .where(eq(rental_sessions.renter_account_id, renterAccountId))
    .orderBy(desc(rental_sessions.created_at));
}
