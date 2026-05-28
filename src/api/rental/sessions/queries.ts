import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { rental_sessions } from "../../db/schema.js";

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
