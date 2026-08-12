import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { rental_listings, rental_provider_hosts, rental_sessions } from "../../db/schema.js";
import { emitActivityEvent } from "../activity-emitter.js";
import {
  SESSION_ACCEPTED,
  SESSION_CANCELLED,
} from "../activity-event-types.js";
import { isValidTransition } from "../session-state-machine.js";
import { CAPACITY_CONSUMING_STATUSES } from "./queries.js";
import {
  acquireQuotaLeaseForSession,
  releaseQuotaLeaseForSession,
} from "./quota.js";
import { isRentalHostFresh } from "../provider-hosts.js";
import { emitRentalProviderEvent } from "../provider-events.js";
import { revokeRentalLaunchAuthority } from "../session-launch.js";
import { assertRentalRuntimeSelectionSafe } from "../runtime-policy.js";

export interface RentalLaunchSelection {
  hostId: string;
  installationId: string;
  runtime: {
    kind: string;
    modelLabel?: string;
    permissionProfileId?: string;
  };
}

export function isRentalLaunchRetry(status: string, launchState: string | null): boolean {
  return status === "accepted" && launchState === "launch_failed";
}

export function rentalLaunchIdentityReset(): {
  daemon_entry_id: null;
  room_agent_session_id: null;
} {
  return { daemon_entry_id: null, room_agent_session_id: null };
}

async function settleTerminalRentalControls(
  session: typeof rental_sessions.$inferSelect,
  providerAccountId: string,
  reason: string,
): Promise<void> {
  const results = await Promise.allSettled([
    releaseQuotaLeaseForSession(session, reason),
    revokeRentalLaunchAuthority(session.id, providerAccountId),
  ]);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

export async function acceptSession(
  sessionId: string,
  providerAccountId: string,
  launch?: RentalLaunchSelection,
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

  if (session.room_placement === "direct_member" && !launch) {
    throw new Error("launch_selection_required");
  }
  const safeLaunch = launch
    ? { ...launch, runtime: assertRentalRuntimeSelectionSafe(launch.runtime) }
    : undefined;

  // Retrying the exact pending accept is how Desktop closes the durable
  // pre-accept journal window after a crash or ambiguous network response.
  if (session.status === "accepted" && session.launch_state === "pending" && safeLaunch) {
    const [host] = await db.select().from(rental_provider_hosts).where(and(
      eq(rental_provider_hosts.provider_account_id, providerAccountId),
      eq(rental_provider_hosts.host_id, safeLaunch.hostId),
      eq(rental_provider_hosts.installation_id, safeLaunch.installationId),
    )).limit(1);
    const selected = session.selected_runtime;
    if (
      host?.id === session.provider_host_id
      && selected?.kind === safeLaunch.runtime.kind
      && selected.permissionProfileId === safeLaunch.runtime.permissionProfileId
      && (selected.modelLabel ?? null) === (safeLaunch.runtime.modelLabel ?? null)
    ) {
      return session;
    }
    throw new Error("accept_selection_mismatch");
  }

  const retryingLaunch = isRentalLaunchRetry(session.status, session.launch_state);
  if (!retryingLaunch && !isValidTransition(session.status, "accepted")) {
    throw new Error(
      `invalid_transition: cannot move from ${session.status} to accepted`,
    );
  }
  if (retryingLaunch && !launch) throw new Error("launch_selection_required");
  if (!retryingLaunch && session.request_expires_at && session.request_expires_at.getTime() <= Date.now()) {
    await db.update(rental_sessions).set({
      status: "expired",
      ended_at: new Date(),
      updated_at: new Date(),
    }).where(and(eq(rental_sessions.id, sessionId), eq(rental_sessions.status, "requested")));
    throw new Error("request_expired");
  }

  const [listing] = await db
    .select()
    .from(rental_listings)
    .where(eq(rental_listings.id, session.listing_id));
  if (!listing) {
    throw new Error("listing_not_found");
  }
  if (listing.provider_host_id && !safeLaunch) {
    throw new Error("launch_selection_required");
  }
  if (safeLaunch && session.room_placement !== "direct_member") {
    throw new Error("launch_selection_unsupported");
  }

  const lease = await acquireQuotaLeaseForSession(session, listing);
  let updated: typeof rental_sessions.$inferSelect | undefined;
  try {
    updated = await db.transaction(async (tx) => {
      const listingFence = `rental_listing_capacity:${listing.id}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${listingFence}, 0))`);
      const [listingCapacity] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(rental_sessions)
        .where(and(
          eq(rental_sessions.listing_id, listing.id),
          inArray(rental_sessions.status, [...CAPACITY_CONSUMING_STATUSES]),
          ...(retryingLaunch ? [ne(rental_sessions.id, sessionId)] : []),
        ));
      if ((listingCapacity?.count ?? 0) >= listing.max_concurrent_sessions) {
        throw new Error("listing_at_capacity");
      }

      let providerHostId: string | null = null;
      let selectedRuntime: RentalLaunchSelection["runtime"] | null = null;
      if (safeLaunch) {
        const fenceKey = `rental_host_capacity:${providerAccountId}:${safeLaunch.hostId}:${safeLaunch.installationId}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${fenceKey}, 0))`);
        const [host] = await tx.select().from(rental_provider_hosts).where(and(
          eq(rental_provider_hosts.provider_account_id, providerAccountId),
          eq(rental_provider_hosts.host_id, safeLaunch.hostId),
          eq(rental_provider_hosts.installation_id, safeLaunch.installationId),
        )).limit(1);
        if (!host || !host.enabled || !isRentalHostFresh(host.last_heartbeat_at)) {
          throw new Error("provider_host_unavailable");
        }
        if (listing.provider_host_id && listing.provider_host_id !== host.id) {
          throw new Error("listing_host_mismatch");
        }
        const runtime = (host.runtimes ?? []).find((candidate) =>
          candidate.kind === safeLaunch.runtime.kind && candidate.authenticated,
        );
        if (!runtime) throw new Error("runtime_unavailable");
        if (!runtime.permissionProfiles?.includes(safeLaunch.runtime.permissionProfileId)) {
          throw new Error("permission_profile_unavailable");
        }
        const [capacity] = await tx.select({ count: sql<number>`count(*)::int` })
          .from(rental_sessions)
          .where(and(
            eq(rental_sessions.provider_host_id, host.id),
            inArray(rental_sessions.status, [...CAPACITY_CONSUMING_STATUSES]),
            ...(retryingLaunch ? [ne(rental_sessions.id, sessionId)] : []),
          ));
        if ((capacity?.count ?? 0) >= host.max_concurrent_sessions) {
          throw new Error("provider_host_at_capacity");
        }
        providerHostId = host.id;
        selectedRuntime = {
          kind: safeLaunch.runtime.kind,
          ...(safeLaunch.runtime.modelLabel ? { modelLabel: safeLaunch.runtime.modelLabel } : {}),
          permissionProfileId: safeLaunch.runtime.permissionProfileId,
        };
      }
      const [accepted] = await tx
        .update(rental_sessions)
        .set({
          status: "accepted",
          quota_lease: lease,
          native_quota_unit: lease.snapshot.nativeUnit,
          native_quota_start_snapshot: lease.snapshot,
          native_quota_latest_snapshot: lease.snapshot,
          meter_confidence: lease.snapshot.confidence,
          provider_host_id: providerHostId,
          selected_runtime: selectedRuntime,
          launch_attempt: safeLaunch ? session.launch_attempt + 1 : 0,
          launch_state: safeLaunch ? "pending" : null,
          launch_error_code: null,
          launch_error_message: null,
          ...rentalLaunchIdentityReset(),
          updated_at: new Date(),
        })
        .where(and(
          eq(rental_sessions.id, sessionId),
          eq(rental_sessions.status, retryingLaunch ? "accepted" : "requested"),
          ...(retryingLaunch ? [eq(rental_sessions.launch_state, "launch_failed")] : []),
        ))
        .returning();
      if (!accepted) throw new Error("accept_fence_lost");
      return accepted;
    });
  } catch (error) {
    if (!retryingLaunch) {
      const [current] = await db.select({ status: rental_sessions.status })
        .from(rental_sessions).where(eq(rental_sessions.id, sessionId)).limit(1);
      // A concurrent winner owns the same session lease. Never let the losing
      // request release capacity out from under that accepted session.
      if (current?.status === "requested") {
        await releaseQuotaLeaseForSession(session, "accept_failed");
      }
    }
    throw error;
  }

  if (session.room_id && !retryingLaunch) {
    await emitActivityEvent({
      sessionId,
      roomId: session.room_id,
      eventType: SESSION_ACCEPTED,
      source: "provider",
      payload: { provider_account_id: providerAccountId },
    });
  }

  await emitRentalProviderEvent({
    providerAccountId,
    sessionId,
    kind: "session.accepted",
    payload: { launchAttempt: updated.launch_attempt },
  }).catch(() => undefined);

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
    .where(and(
      eq(rental_sessions.id, sessionId),
      eq(rental_sessions.status, session.status),
    ))
    .returning();

  if (!updated) throw new Error("transition_fence_lost");

  // Terminal cleanup must not depend on activity publication: a temporary
  // event failure cannot leave the provider's quota lane locked forever.
  await settleTerminalRentalControls(updated, providerAccountId, "declined");

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
    .where(and(
      eq(rental_sessions.id, sessionId),
      eq(rental_sessions.status, session.status),
    ))
    .returning();

  if (!updated) throw new Error("transition_fence_lost");

  await settleTerminalRentalControls(updated, session.provider_account_id, "cancelled");

  if (session.room_id) {
    await emitActivityEvent({
      sessionId,
      roomId: session.room_id,
      eventType: SESSION_CANCELLED,
      source: role,
      payload: { cancelled_by: role },
    });
  }

  await emitRentalProviderEvent({
    providerAccountId: session.provider_account_id,
    sessionId,
    kind: "request.cancelled",
    payload: { cancelledBy: role },
  }).catch(() => undefined);

  return updated;
}
