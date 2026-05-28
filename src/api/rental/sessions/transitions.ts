import { and, eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { rental_listings, rental_sessions } from "../../db/schema.js";
import { emitActivityEvent } from "../activity-emitter.js";
import {
  SESSION_ACCEPTED,
  SESSION_CANCELLED,
} from "../activity-event-types.js";
import { isValidTransition } from "../session-state-machine.js";
import {
  acquireQuotaLeaseForSession,
  releaseQuotaLeaseForSession,
} from "./quota.js";

export async function acceptSession(
  sessionId: string,
  providerAccountId: string,
): Promise<typeof rental_sessions.$inferSelect | null> {
  const [session] = await db
    .select()
    .from(rental_sessions)
    .where(
      and(
        eq(rental_sessions.id, sessionId),
        eq(rental_sessions.provider_account_id, providerAccountId),
      ),
    );

  if (!session) return null;

  if (!isValidTransition(session.status, "accepted")) {
    throw new Error(
      `invalid_transition: cannot move from ${session.status} to accepted`,
    );
  }

  const [listing] = await db
    .select()
    .from(rental_listings)
    .where(eq(rental_listings.id, session.listing_id));
  if (!listing) {
    throw new Error("listing_not_found");
  }

  const lease = await acquireQuotaLeaseForSession(session, listing);

  const [updated] = await db
    .update(rental_sessions)
    .set({
      status: "accepted",
      quota_lease: lease,
      native_quota_unit: lease.snapshot.nativeUnit,
      native_quota_start_snapshot: lease.snapshot,
      native_quota_latest_snapshot: lease.snapshot,
      meter_confidence: lease.snapshot.confidence,
      updated_at: new Date(),
    })
    .where(eq(rental_sessions.id, sessionId))
    .returning();

  if (session.room_id) {
    await emitActivityEvent({
      sessionId,
      roomId: session.room_id,
      eventType: SESSION_ACCEPTED,
      source: "provider",
      payload: { provider_account_id: providerAccountId },
    });
  }

  return updated;
}

export async function declineSession(
  sessionId: string,
  providerAccountId: string,
): Promise<typeof rental_sessions.$inferSelect | null> {
  const [session] = await db
    .select()
    .from(rental_sessions)
    .where(
      and(
        eq(rental_sessions.id, sessionId),
        eq(rental_sessions.provider_account_id, providerAccountId),
      ),
    );

  if (!session) return null;

  if (!isValidTransition(session.status, "cancelled")) {
    throw new Error(
      `invalid_transition: cannot move from ${session.status} to cancelled`,
    );
  }

  const [updated] = await db
    .update(rental_sessions)
    .set({
      status: "cancelled",
      ended_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(rental_sessions.id, sessionId))
    .returning();

  if (session.room_id) {
    await emitActivityEvent({
      sessionId,
      roomId: session.room_id,
      eventType: SESSION_CANCELLED,
      source: "provider",
      payload: { reason: "declined" },
    });
  }

  return updated;
}

export async function cancelSession(
  sessionId: string,
  accountId: string,
  role: "renter" | "provider",
): Promise<typeof rental_sessions.$inferSelect | null> {
  const accountField =
    role === "renter"
      ? rental_sessions.renter_account_id
      : rental_sessions.provider_account_id;

  const [session] = await db
    .select()
    .from(rental_sessions)
    .where(
      and(eq(rental_sessions.id, sessionId), eq(accountField, accountId)),
    );

  if (!session) return null;

  if (!isValidTransition(session.status, "cancelled")) {
    throw new Error(
      `invalid_transition: cannot move from ${session.status} to cancelled`,
    );
  }

  const [updated] = await db
    .update(rental_sessions)
    .set({
      status: "cancelled",
      ended_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(rental_sessions.id, sessionId))
    .returning();

  if (session.room_id) {
    await emitActivityEvent({
      sessionId,
      roomId: session.room_id,
      eventType: SESSION_CANCELLED,
      source: role,
      payload: { cancelled_by: role },
    });
  }

  await releaseQuotaLeaseForSession(updated, "cancelled");

  return updated;
}
