/**
 * Rental Sessions Service — p1.3
 *
 * Implements the session lifecycle state machine (§18):
 *   create   — renter initiates a session request
 *   accept   — provider accepts a pending request
 *   decline  — provider declines a pending request
 *   cancel   — renter or provider cancels an active/requested session
 *   getById  — fetch a single session
 *   listProviderRequests — provider sees incoming requests
 *   listRenterSessions  — renter sees their sessions
 *
 * State transitions validated against §18.2.
 * All mutations are ownership-scoped.
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  rental_sessions,
  rental_listings,
} from "../db/schema.js";
import { emitActivityEvent } from "./activity-emitter.js";
import {
  SESSION_STARTED,
  SESSION_ACCEPTED,
  SESSION_CANCELLED,
  type RentalActivityEventType,
} from "./activity-event-types.js";
import {
  acquireLease,
  defaultQuotaLeaseOrchestratorDeps,
  releaseSessionLease,
  type AcquireLeaseFailure,
  type QuotaLeaseOrchestratorDeps,
} from "./quota-lease-orchestrator.js";
import type {
  QuotaLane,
  QuotaLease,
  QuotaLeaseSnapshot,
} from "./quota-lease.js";
import type {
  NativeQuotaSnapshot,
  QuotaConfidence,
  QuotaUnit,
} from "../../shared/rental/meter-types.js";

import { isValidTransition } from "./session-state-machine.js";

// Re-export for backwards compatibility
export { isValidTransition } from "./session-state-machine.js";

// ===== ID generation =====

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `rsess_${timestamp}_${random}`;
}

// ===== Service functions =====

export interface CreateSessionInput {
  listingId: string;
  renterAccountId: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  taskTitle: string;
  taskPrompt: string;
  mode?: "scoped" | "trusted_open";
  continuityMode?: "smart_handoff" | "full_transcript";
  // D3 trigger context (optional)
  startTrigger?: "quota_exhausted" | "user_initiated" | "scheduled" | "task_handoff";
  triggerConfidence?: "exact" | "inferred" | "manual";
  renterLaneProvider?: string;
  renterLaneModel?: string;
  renterLaneExhaustedAt?: Date;
  renterLaneRefreshEta?: Date;
  renterQuotaSignal?: Record<string, unknown>;
  // Quota limits
  lrtLimit?: number;
  timeLimitMinutes?: number;
}

type RentalSessionRow = typeof rental_sessions.$inferSelect;
type RentalListingRow = typeof rental_listings.$inferSelect;

const QUOTA_CONFIDENCE_VALUES = new Set<QuotaConfidence>([
  "official_exact",
  "local_exact",
  "derived",
  "calibrated",
  "estimated",
  "weak_estimate",
  "unknown",
]);

const QUOTA_UNIT_VALUES = new Set<QuotaUnit>([
  "tokens",
  "credits",
  "usd",
  "requests",
  "percent_window",
  "time",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function confidenceOrUnknown(value: unknown): QuotaConfidence {
  return typeof value === "string" && QUOTA_CONFIDENCE_VALUES.has(value as QuotaConfidence)
    ? value as QuotaConfidence
    : "unknown";
}

function unitOrUnknown(value: unknown): QuotaUnit {
  return typeof value === "string" && QUOTA_UNIT_VALUES.has(value as QuotaUnit)
    ? value as QuotaUnit
    : "unknown";
}

export function buildQuotaLeaseInput(
  session: Pick<RentalSessionRow, "id" | "room_id">,
  listing: Pick<
    RentalListingRow,
    | "ide_kind"
    | "model_label"
    | "quota_lane_id"
    | "native_quota_unit"
    | "last_native_quota_snapshot"
    | "last_quota_reset_at"
    | "meter_confidence"
  >,
  nowIso: string = new Date().toISOString(),
): {
  sessionId: string;
  roomId: string | null;
  lane: QuotaLane;
  snapshot: QuotaLeaseSnapshot;
} {
  const rawSnapshot = isRecord(listing.last_native_quota_snapshot)
    ? listing.last_native_quota_snapshot as Partial<NativeQuotaSnapshot>
    : null;
  const rawResetAt = stringOrNull(rawSnapshot?.nativeResetAt)
    ?? listing.last_quota_reset_at?.toISOString()
    ?? null;

  return {
    sessionId: session.id,
    roomId: session.room_id,
    lane: {
      provider: listing.ide_kind,
      model: listing.model_label ?? null,
      quotaLaneId: listing.quota_lane_id ?? null,
    },
    snapshot: {
      nativeUnit: unitOrUnknown(rawSnapshot?.nativeUnit ?? listing.native_quota_unit),
      nativeRemaining: finiteNumberOrNull(rawSnapshot?.nativeRemaining),
      nativeResetAt: rawResetAt,
      confidence: confidenceOrUnknown(rawSnapshot?.confidence ?? listing.meter_confidence),
      observedAt: stringOrNull(rawSnapshot?.observedAt) ?? nowIso,
    },
  };
}

export function quotaLeaseError(result: AcquireLeaseFailure): Error {
  const conflict = result.conflictingSessionId
    ? ` held_by=${result.conflictingSessionId}`
    : "";
  return new Error(`quota_lease_${result.reason}${conflict}`);
}

export async function acquireQuotaLeaseForSession(
  session: Pick<RentalSessionRow, "id" | "room_id">,
  listing: Parameters<typeof buildQuotaLeaseInput>[1],
  deps: QuotaLeaseOrchestratorDeps = defaultQuotaLeaseOrchestratorDeps,
): Promise<QuotaLease> {
  const result = await acquireLease(buildQuotaLeaseInput(session, listing, deps.now()), deps);
  if (!result.ok) {
    throw quotaLeaseError(result);
  }
  return result.lease;
}

export async function releaseQuotaLeaseForSession(
  session: Pick<RentalSessionRow, "id" | "room_id">,
  reason: string,
  deps: QuotaLeaseOrchestratorDeps = defaultQuotaLeaseOrchestratorDeps,
): Promise<void> {
  await releaseSessionLease({
    sessionId: session.id,
    roomId: session.room_id,
    reason,
  }, deps);
}

export async function createSession(
  input: CreateSessionInput
): Promise<typeof rental_sessions.$inferSelect> {
  // Verify listing exists and is active
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

  // Verify requested mode is supported by listing
  const requestedMode = input.mode ?? "scoped";
  const supportedModes = listing.supported_modes ?? ["scoped"];
  if (!supportedModes.includes(requestedMode)) {
    throw new Error("mode_not_supported");
  }

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
      status: "requested",
      lrt_limit: input.lrtLimit ?? listing.default_lrt_limit,
      time_limit_minutes:
        input.timeLimitMinutes ?? listing.default_time_limit_minutes,
      // D3 trigger context
      start_trigger: input.startTrigger,
      trigger_confidence: input.triggerConfidence,
      renter_lane_provider: input.renterLaneProvider,
      renter_lane_model: input.renterLaneModel,
      renter_lane_exhausted_at: input.renterLaneExhaustedAt,
      renter_lane_refresh_eta: input.renterLaneRefreshEta,
      renter_quota_signal: input.renterQuotaSignal,
    })
    .returning();

  // Emit session.started event — deferred if no room_id yet (room is
  // created during provisioning, §18.2). Pre-room events are backfilled
  // when the room is assigned.
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

export async function acceptSession(
  sessionId: string,
  providerAccountId: string
): Promise<typeof rental_sessions.$inferSelect | null> {
  const [session] = await db
    .select()
    .from(rental_sessions)
    .where(
      and(
        eq(rental_sessions.id, sessionId),
        eq(rental_sessions.provider_account_id, providerAccountId)
      )
    );

  if (!session) return null;

  if (!isValidTransition(session.status, "accepted")) {
    throw new Error(
      `invalid_transition: cannot move from ${session.status} to accepted`
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
  providerAccountId: string
): Promise<typeof rental_sessions.$inferSelect | null> {
  const [session] = await db
    .select()
    .from(rental_sessions)
    .where(
      and(
        eq(rental_sessions.id, sessionId),
        eq(rental_sessions.provider_account_id, providerAccountId)
      )
    );

  if (!session) return null;

  if (!isValidTransition(session.status, "cancelled")) {
    throw new Error(
      `invalid_transition: cannot move from ${session.status} to cancelled`
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
  role: "renter" | "provider"
): Promise<typeof rental_sessions.$inferSelect | null> {
  const accountField =
    role === "renter"
      ? rental_sessions.renter_account_id
      : rental_sessions.provider_account_id;

  const [session] = await db
    .select()
    .from(rental_sessions)
    .where(
      and(eq(rental_sessions.id, sessionId), eq(accountField, accountId))
    );

  if (!session) return null;

  if (!isValidTransition(session.status, "cancelled")) {
    throw new Error(
      `invalid_transition: cannot move from ${session.status} to cancelled`
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

export async function getSessionById(
  sessionId: string,
  accountId: string
): Promise<typeof rental_sessions.$inferSelect | null> {
  const [session] = await db
    .select()
    .from(rental_sessions)
    .where(eq(rental_sessions.id, sessionId));

  if (!session) return null;

  // Only the renter or provider can see the session
  if (
    session.renter_account_id !== accountId &&
    session.provider_account_id !== accountId
  ) {
    return null;
  }

  return session;
}

export async function listProviderRequests(
  providerAccountId: string
): Promise<(typeof rental_sessions.$inferSelect)[]> {
  return db
    .select()
    .from(rental_sessions)
    .where(
      and(
        eq(rental_sessions.provider_account_id, providerAccountId),
        eq(rental_sessions.status, "requested")
      )
    )
    .orderBy(desc(rental_sessions.created_at));
}

export async function listRenterSessions(
  renterAccountId: string
): Promise<(typeof rental_sessions.$inferSelect)[]> {
  return db
    .select()
    .from(rental_sessions)
    .where(eq(rental_sessions.renter_account_id, renterAccountId))
    .orderBy(desc(rental_sessions.created_at));
}
