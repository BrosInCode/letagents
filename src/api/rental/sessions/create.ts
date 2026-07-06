import { eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { rental_listings, rental_sessions } from "../../db/schema.js";
import { emitActivityEvent } from "../activity-emitter.js";
import { SESSION_STARTED } from "../activity-event-types.js";
import type { CreateSessionInput } from "./types.js";

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `rsess_${timestamp}_${random}`;
}

/**
 * Resolve the effective LRT limit for a new session, preferring the
 * renter-supplied value over the listing default.
 *
 * A session without an LRT limit can never pass the Budget Sentinel
 * (effectiveLrtCeiling(null) → 0 denies every step), so it would sit
 * active-but-unusable. Reject at creation instead.
 */
export function resolveSessionLrtLimit(
  inputLimit: number | undefined,
  listingDefault: number | null,
): number {
  const lrtLimit = inputLimit ?? listingDefault;
  if (lrtLimit === null || lrtLimit === undefined) {
    throw new Error("lrt_limit_required");
  }
  if (!Number.isInteger(lrtLimit) || lrtLimit <= 0) {
    throw new Error("lrt_limit_invalid");
  }
  return lrtLimit;
}

export async function createSession(
  input: CreateSessionInput,
): Promise<typeof rental_sessions.$inferSelect> {
  const [listing] = await db
    .select()
    .from(rental_listings)
    .where(eq(rental_listings.id, input.listingId));

  if (!listing) {
    throw new Error("listing_not_found");
  }
  if (listing.status !== "active") {
    throw new Error("listing_not_active");
  }

  const requestedMode = input.mode ?? "scoped";
  const supportedModes = listing.supported_modes ?? ["scoped"];
  if (!supportedModes.includes(requestedMode)) {
    throw new Error("mode_not_supported");
  }

  const lrtLimit = resolveSessionLrtLimit(
    input.lrtLimit,
    listing.default_lrt_limit,
  );

  const id = generateSessionId();

  const [session] = await db
    .insert(rental_sessions)
    .values({
      id,
      listing_id: input.listingId,
      renter_account_id: input.renterAccountId,
      provider_account_id: listing.provider_account_id,
      repo_provider: "github",
      repo_owner: input.repoOwner,
      repo_name: input.repoName,
      base_branch: input.baseBranch,
      task_title: input.taskTitle,
      task_prompt: input.taskPrompt,
      mode: requestedMode,
      continuity_mode: input.continuityMode ?? "smart_handoff",
      approved_scope: input.approvedScope ?? null,
      policy: input.policy ?? null,
      status: "requested",
      lrt_limit: lrtLimit,
      time_limit_minutes:
        input.timeLimitMinutes ?? listing.default_time_limit_minutes,
      start_trigger: input.startTrigger,
      trigger_confidence: input.triggerConfidence,
      renter_lane_provider: input.renterLaneProvider,
      renter_lane_model: input.renterLaneModel,
      renter_lane_exhausted_at: input.renterLaneExhaustedAt,
      renter_lane_refresh_eta: input.renterLaneRefreshEta,
      renter_quota_signal: input.renterQuotaSignal,
    })
    .returning();

  if (session.room_id) {
    await emitActivityEvent({
      sessionId: id,
      roomId: session.room_id,
      eventType: SESSION_STARTED,
      source: "renter",
      payload: {
        listing_id: input.listingId,
        mode: requestedMode,
        start_trigger: input.startTrigger ?? null,
        trigger_confidence: input.triggerConfidence ?? null,
      },
    });
  }

  return session;
}
