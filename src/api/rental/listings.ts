/**
 * Rental listings service — provider-facing CRUD.
 *
 * Manages rental_listings rows: create, update, pause, resume, list.
 * Part of PR p1.1 (Phase 1: Session Lifecycle & Listings).
 *
 * Spec §19.1 (rental_listings table) + §6 (provider listing flow).
 */

import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { rental_listings, rental_provider_hosts } from "../db/schema.js";

// ===== Types =====

export interface CreateListingInput {
  providerAccountId: string;
  providerHostId?: string | null;
  displayName: string;
  ideKind: string;
  modelLabel?: string | null;
  quotaLaneId?: string | null;
  quotaLaneLabel?: string | null;
  supportedModes?: string[];
  defaultLrtLimit?: number | null;
  defaultTimeLimitMinutes?: number | null;
  manualAcceptRequired?: boolean;
  maxConcurrentSessions?: number | null;
}

export interface UpdateListingInput {
  providerHostId?: string | null;
  displayName?: string;
  modelLabel?: string | null;
  quotaLaneId?: string | null;
  quotaLaneLabel?: string | null;
  supportedModes?: string[];
  defaultLrtLimit?: number | null;
  defaultTimeLimitMinutes?: number | null;
  manualAcceptRequired?: boolean;
  maxConcurrentSessions?: number | null;
}

export type RentalListing = typeof rental_listings.$inferSelect;

// ===== Service Functions =====

function generateListingId(): string {
  return `rlist_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function createListing(
  input: CreateListingInput
): Promise<RentalListing> {
  if (input.providerHostId) {
    const [ownedHost] = await db.select({ id: rental_provider_hosts.id })
      .from(rental_provider_hosts).where(and(
        eq(rental_provider_hosts.id, input.providerHostId),
        eq(rental_provider_hosts.provider_account_id, input.providerAccountId),
      )).limit(1);
    if (!ownedHost) throw new Error("provider_host_not_owned");
  }
  const id = generateListingId();
  const now = new Date();

  const [listing] = await db
    .insert(rental_listings)
    .values({
      id,
      provider_account_id: input.providerAccountId,
      provider_host_id: input.providerHostId ?? null,
      display_name: input.displayName,
      status: "setup_required",
      verification_status: "experimental",
      ide_kind: input.ideKind,
      model_label: input.modelLabel ?? null,
      quota_lane_id: input.quotaLaneId ?? null,
      quota_lane_label: input.quotaLaneLabel ?? null,
      supported_modes: input.supportedModes ?? ["scoped"],
      default_lrt_limit: input.defaultLrtLimit ?? null,
      default_time_limit_minutes: input.defaultTimeLimitMinutes ?? null,
      manual_accept_required: input.manualAcceptRequired ?? true,
      max_concurrent_sessions: input.maxConcurrentSessions ?? 1,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return listing;
}

export async function updateListing(
  listingId: string,
  providerAccountId: string,
  input: UpdateListingInput
): Promise<RentalListing | null> {
  if (input.providerHostId) {
    const [ownedHost] = await db.select({ id: rental_provider_hosts.id })
      .from(rental_provider_hosts).where(and(
        eq(rental_provider_hosts.id, input.providerHostId),
        eq(rental_provider_hosts.provider_account_id, providerAccountId),
      )).limit(1);
    if (!ownedHost) throw new Error("provider_host_not_owned");
  }
  const updates: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (input.displayName !== undefined) updates.display_name = input.displayName;
  if (input.providerHostId !== undefined) updates.provider_host_id = input.providerHostId;
  if (input.modelLabel !== undefined) updates.model_label = input.modelLabel;
  if (input.quotaLaneId !== undefined) updates.quota_lane_id = input.quotaLaneId;
  if (input.quotaLaneLabel !== undefined) updates.quota_lane_label = input.quotaLaneLabel;
  if (input.supportedModes !== undefined) updates.supported_modes = input.supportedModes;
  if (input.defaultLrtLimit !== undefined) updates.default_lrt_limit = input.defaultLrtLimit;
  if (input.defaultTimeLimitMinutes !== undefined)
    updates.default_time_limit_minutes = input.defaultTimeLimitMinutes;
  if (input.maxConcurrentSessions !== undefined && input.maxConcurrentSessions !== null)
    updates.max_concurrent_sessions = input.maxConcurrentSessions;
  if (input.manualAcceptRequired !== undefined)
    updates.manual_accept_required = input.manualAcceptRequired;

  const [updated] = await db
    .update(rental_listings)
    .set(updates)
    .where(
      and(
        eq(rental_listings.id, listingId),
        eq(rental_listings.provider_account_id, providerAccountId)
      )
    )
    .returning();

  return updated ?? null;
}

export async function pauseListing(
  listingId: string,
  providerAccountId: string
): Promise<RentalListing | null> {
  const [updated] = await db
    .update(rental_listings)
    .set({ status: "paused", updated_at: new Date() })
    .where(
      and(
        eq(rental_listings.id, listingId),
        eq(rental_listings.provider_account_id, providerAccountId)
      )
    )
    .returning();

  return updated ?? null;
}

export async function resumeListing(
  listingId: string,
  providerAccountId: string
): Promise<RentalListing | null> {
  const [updated] = await db
    .update(rental_listings)
    .set({ status: "active", updated_at: new Date() })
    .where(
      and(
        eq(rental_listings.id, listingId),
        eq(rental_listings.provider_account_id, providerAccountId)
      )
    )
    .returning();

  return updated ?? null;
}

export async function listMyListings(
  providerAccountId: string
): Promise<RentalListing[]> {
  return db
    .select()
    .from(rental_listings)
    .where(eq(rental_listings.provider_account_id, providerAccountId))
    .orderBy(desc(rental_listings.created_at));
}

export async function getListingById(
  listingId: string
): Promise<RentalListing | null> {
  const [listing] = await db
    .select()
    .from(rental_listings)
    .where(eq(rental_listings.id, listingId));

  return listing ?? null;
}

// ===== Public discovery (renter-facing) =====

/**
 * Filters accepted by the renter-facing public listings query.
 *
 * All optional. `mode` filters listings whose `supported_modes` jsonb
 * array contains the requested mode; the column is a `jsonb` containing
 * a string array (e.g. `["scoped"]` or `["scoped", "trusted_open"]`).
 *
 * Spec §20 (API surface) + §22.2 (Available to rent UX).
 */
export interface PublicListingFilters {
  ideKind?: string;
  modelLabel?: string;
  mode?: "scoped" | "trusted_open";
  limit?: number;
  offset?: number;
}

/**
 * One row returned by {@link publicListings}.
 *
 * V1 redaction policy: drop fields that should not be enumerable by
 * arbitrary renters (provider account id, internal native quota
 * snapshots, exact internal LRT estimates). The renter sees the
 * marketplace-facing identity + IDE/model + capacity hint only.
 *
 * Per spec §1.5 readiness gating: only verified+active listings appear.
 */
export interface PublicRentalListing {
  id: string;
  displayName: string;
  ideKind: string;
  modelLabel: string | null;
  quotaLaneLabel: string | null;
  meterConfidence: string;
  nativeQuotaUnit: string;
  supportedModes: string[];
  manualAcceptRequired: boolean;
  defaultLrtLimit: number | null;
  defaultTimeLimitMinutes: number | null;
  // Capacity hint, derived from the last LRT estimate when present.
  // Intentionally rough — exact native numbers stay provider-private.
  lrtEstimate: number | null;
  lastQuotaResetAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const MAX_PUBLIC_LIMIT = 50;
const DEFAULT_PUBLIC_LIMIT = 25;

/**
 * Renter-facing public listings query.
 *
 * Only returns rows where:
 *   verification_status = 'verified' AND status = 'active'
 *
 * Applies optional filters and returns redacted listings. Paginated;
 * `limit` is capped at {@link MAX_PUBLIC_LIMIT}.
 */
export async function publicListings(
  filters: PublicListingFilters = {}
): Promise<PublicRentalListing[]> {
  const limit = clampPageLimit(filters.limit);
  const offset = filters.offset && filters.offset > 0 ? filters.offset : 0;

  const conditions = [
    eq(rental_listings.verification_status, "verified"),
    eq(rental_listings.status, "active"),
  ];

  if (filters.ideKind) {
    conditions.push(eq(rental_listings.ide_kind, filters.ideKind));
  }
  if (filters.modelLabel) {
    conditions.push(eq(rental_listings.model_label, filters.modelLabel));
  }
  if (filters.mode) {
    // Postgres JSONB containment: supported_modes is a jsonb array of
    // strings such as ["scoped", "trusted_open"]. Push the filter into
    // SQL so it composes with pagination correctly — applying the
    // filter after limit/offset (the previous in-memory approach) would
    // return empty/underfilled pages when matches exist further down.
    // Matches the existing `@>` jsonb pattern in src/api/db.ts.
    conditions.push(
      sql`${rental_listings.supported_modes} @> ${JSON.stringify([filters.mode])}::jsonb`,
    );
  }

  const rows = await db
    .select()
    .from(rental_listings)
    .where(and(...conditions))
    .orderBy(desc(rental_listings.updated_at))
    .limit(limit)
    .offset(offset);

  return rows.map(redactPublicListing);
}

/**
 * Same query as {@link publicListings} but accepts an injected `query`
 * function so route tests can exercise the routing layer without a
 * live DB. The default `query` impl is the drizzle implementation
 * above.
 */
export type PublicListingsQuery = (filters: PublicListingFilters) => Promise<PublicRentalListing[]>;

export function clampPageLimit(limit: number | undefined): number {
  if (!limit || limit < 1) return DEFAULT_PUBLIC_LIMIT;
  return Math.min(MAX_PUBLIC_LIMIT, Math.floor(limit));
}

/**
 * Redact a raw `RentalListing` row into the renter-facing shape.
 *
 * Drops:
 *   provider_account_id        — internal owner identity
 *   quota_lane_id              — internal lane key
 *   last_native_quota_snapshot — exact native numbers
 *   last_lrt_estimate          — kept as a single `lrtEstimate` field;
 *                                clients see only an integer capacity hint.
 *   verified_agent_fingerprint_id
 *   max_concurrent_sessions    — internal accounting
 *
 * Keeps marketplace-facing identity (displayName / ideKind / model /
 * quotaLaneLabel / meterConfidence) so the renter can choose.
 */
export function redactPublicListing(row: RentalListing): PublicRentalListing {
  return {
    id: row.id,
    displayName: row.display_name,
    ideKind: row.ide_kind,
    modelLabel: row.model_label ?? null,
    quotaLaneLabel: row.quota_lane_label ?? null,
    meterConfidence: row.meter_confidence,
    nativeQuotaUnit: row.native_quota_unit,
    supportedModes: Array.isArray(row.supported_modes) ? (row.supported_modes as string[]) : [],
    manualAcceptRequired: row.manual_accept_required,
    defaultLrtLimit: row.default_lrt_limit ?? null,
    defaultTimeLimitMinutes: row.default_time_limit_minutes ?? null,
    lrtEstimate: row.last_lrt_estimate ?? null,
    lastQuotaResetAt: row.last_quota_reset_at?.toISOString() ?? null,
    createdAt: row.created_at?.toISOString() ?? null,
    updatedAt: row.updated_at?.toISOString() ?? null,
  };
}
