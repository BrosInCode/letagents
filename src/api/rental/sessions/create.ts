import { eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { rental_listings, rental_provider_hosts, rental_sessions } from "../../db/schema.js";
import { emitRentalProviderEvent } from "../provider-events.js";
import type { CreateSessionInput } from "./types.js";
import { isRentalHostFresh } from "../provider-hosts.js";

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

export function deriveRentalCapabilityEnvelope(input: CreateSessionInput): Record<string, unknown> {
  const repository = input.repoOwner && input.repoName && input.baseBranch
    ? {
        provider: "github",
        owner: input.repoOwner,
        name: input.repoName,
        baseBranch: input.baseBranch,
        access: "scoped",
      }
    : null;
  return {
    room: {
      id: input.targetRoomId ?? null,
      history: resolveRentalRoomHistoryAccess(input),
    },
    repository,
    commands: false,
    network: false,
    externalActions: false,
  };
}

export function resolveRentalRoomHistoryAccess(
  input: Pick<CreateSessionInput, "targetRoomId" | "roomHistoryAccess">,
): "full" | "filtered" {
  return input.targetRoomId ? "full" : input.roomHistoryAccess ?? "filtered";
}

export async function createSession(
  input: CreateSessionInput,
): Promise<typeof rental_sessions.$inferSelect> {
  if (input.targetRoomId && (input.repoOwner || input.repoName || input.baseBranch)) {
    throw new Error("repository_rentals_not_available");
  }
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
  if (listing.provider_host_id) {
    const [host] = await db.select().from(rental_provider_hosts)
      .where(eq(rental_provider_hosts.id, listing.provider_host_id)).limit(1);
    if (!host || !host.enabled || !isRentalHostFresh(host.last_heartbeat_at)) {
      throw new Error("provider_offline");
    }
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
  const directMember = Boolean(input.targetRoomId);

  const [session] = await db
    .insert(rental_sessions)
    .values({
      id,
      listing_id: input.listingId,
      renter_account_id: input.renterAccountId,
      provider_account_id: listing.provider_account_id,
      target_room_id: input.targetRoomId ?? null,
      room_id: input.targetRoomId ?? null,
      room_placement: directMember ? "direct_member" : "legacy_child",
      room_history_access: resolveRentalRoomHistoryAccess(input),
      // Authority is derived from validated inputs. Never persist a renter's
      // arbitrary JSON as an executable capability grant.
      capability_envelope: deriveRentalCapabilityEnvelope(input),
      repo_provider: input.repoOwner && input.repoName ? "github" : null,
      repo_owner: input.repoOwner ?? null,
      repo_name: input.repoName ?? null,
      base_branch: input.baseBranch ?? null,
      task_title: input.taskTitle,
      task_prompt: input.taskPrompt,
      mode: requestedMode,
      continuity_mode: input.continuityMode ?? "smart_handoff",
      approved_scope: input.approvedScope ?? null,
      policy: input.policy ?? null,
      provider_host_id: listing.provider_host_id,
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
      request_expires_at: new Date(Date.now() + 15 * 60 * 1000),
    })
    .returning();

  await emitRentalProviderEvent({
    providerAccountId: listing.provider_account_id,
    sessionId: session.id,
    kind: "request.created",
    payload: {
      targetRoomId: session.target_room_id,
      taskTitle: session.task_title,
      repositoryAccess: Boolean(session.repo_owner && session.repo_name),
    },
  }).catch(() => undefined);

  return session;
}
