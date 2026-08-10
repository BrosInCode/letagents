import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { accounts, rental_provider_hosts, rental_sessions } from "../../db/schema.js";

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
  let [session] = await db
    .select()
    .from(rental_sessions)
    .where(eq(rental_sessions.id, sessionId));

  if (!session) return null;

  // A read-time expiry transition is still a protected object mutation.
  // Establish renter/provider ownership before changing any session state.
  if (
    session.renter_account_id !== accountId &&
    session.provider_account_id !== accountId
  ) {
    return null;
  }

  if (session.status === "requested" && session.request_expires_at
    && session.request_expires_at.getTime() <= Date.now()) {
    const [expired] = await db.update(rental_sessions).set({
      status: "expired",
      ended_at: new Date(),
      updated_at: new Date(),
    }).where(and(
      eq(rental_sessions.id, session.id),
      eq(rental_sessions.status, "requested"),
    )).returning();
    session = expired ?? session;
  }

  return session;
}

export async function listProviderRequests(
  providerAccountId: string,
): Promise<Array<typeof rental_sessions.$inferSelect & {
  renter_display_name: string;
  renter_login: string;
  renter_avatar_url: string | null;
}>> {
  const now = new Date();
  await db.update(rental_sessions).set({
    status: "expired",
    ended_at: now,
    updated_at: now,
  }).where(and(
    eq(rental_sessions.provider_account_id, providerAccountId),
    eq(rental_sessions.status, "requested"),
    lte(rental_sessions.request_expires_at, now),
  ));
  const rows = await db
    .select({
      session: rental_sessions,
      renterDisplayName: accounts.display_name,
      renterLogin: accounts.login,
      renterAvatarUrl: accounts.avatar_url,
    })
    .from(rental_sessions)
    .innerJoin(accounts, eq(accounts.id, rental_sessions.renter_account_id))
    .where(
      and(
        eq(rental_sessions.provider_account_id, providerAccountId),
        eq(rental_sessions.status, "requested"),
      ),
    )
    .orderBy(desc(rental_sessions.created_at));
  return rows.map(({ session, renterDisplayName, renterLogin, renterAvatarUrl }) => ({
    ...session,
    renter_display_name: renterDisplayName || renterLogin,
    renter_login: renterLogin,
    renter_avatar_url: renterAvatarUrl,
  }));
}

export async function listProviderSessions(
  providerAccountId: string,
  hostId?: string | null,
  installationId?: string | null,
): Promise<(typeof rental_sessions.$inferSelect)[]> {
  const normalizedHostId = hostId?.trim() || null;
  const normalizedInstallationId = installationId?.trim() || null;
  if (Boolean(normalizedHostId) !== Boolean(normalizedInstallationId)) {
    throw new Error("provider_host_identity_required");
  }
  if (normalizedHostId) {
    const rows = await db
      .select({ session: rental_sessions })
      .from(rental_sessions)
      .innerJoin(
        rental_provider_hosts,
        eq(rental_provider_hosts.id, rental_sessions.provider_host_id),
      )
      .where(and(
        eq(rental_sessions.provider_account_id, providerAccountId),
        eq(rental_provider_hosts.provider_account_id, providerAccountId),
        eq(rental_provider_hosts.host_id, normalizedHostId),
        eq(rental_provider_hosts.installation_id, normalizedInstallationId!),
        inArray(rental_sessions.status, [...CAPACITY_CONSUMING_STATUSES]),
      ))
      .orderBy(desc(rental_sessions.updated_at));
    return rows.map(({ session }) => session);
  }
  return db.select().from(rental_sessions)
    .where(and(
      eq(rental_sessions.provider_account_id, providerAccountId),
      inArray(rental_sessions.status, [...CAPACITY_CONSUMING_STATUSES]),
    ))
    .orderBy(desc(rental_sessions.updated_at));
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
