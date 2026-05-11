/**
 * Rental listings service — provider-facing CRUD.
 *
 * Manages rental_listings rows: create, update, pause, resume, list.
 * Part of PR p1.1 (Phase 1: Session Lifecycle & Listings).
 *
 * Spec §19.1 (rental_listings table) + §6 (provider listing flow).
 */

import crypto from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { rental_listings } from "../db/schema.js";

// ===== Types =====

export interface CreateListingInput {
  providerAccountId: string;
  displayName: string;
  ideKind: string;
  modelLabel?: string | null;
  quotaLaneId?: string | null;
  quotaLaneLabel?: string | null;
  supportedModes?: string[];
  defaultLrtLimit?: number | null;
  defaultTimeLimitMinutes?: number | null;
  manualAcceptRequired?: boolean;
}

export interface UpdateListingInput {
  displayName?: string;
  modelLabel?: string | null;
  quotaLaneId?: string | null;
  quotaLaneLabel?: string | null;
  supportedModes?: string[];
  defaultLrtLimit?: number | null;
  defaultTimeLimitMinutes?: number | null;
  manualAcceptRequired?: boolean;
}

export type RentalListing = typeof rental_listings.$inferSelect;

// ===== Service Functions =====

function generateListingId(): string {
  return `rlist_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function createListing(
  input: CreateListingInput
): Promise<RentalListing> {
  const id = generateListingId();
  const now = new Date();

  const [listing] = await db
    .insert(rental_listings)
    .values({
      id,
      provider_account_id: input.providerAccountId,
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
  const updates: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (input.displayName !== undefined) updates.display_name = input.displayName;
  if (input.modelLabel !== undefined) updates.model_label = input.modelLabel;
  if (input.quotaLaneId !== undefined) updates.quota_lane_id = input.quotaLaneId;
  if (input.quotaLaneLabel !== undefined) updates.quota_lane_label = input.quotaLaneLabel;
  if (input.supportedModes !== undefined) updates.supported_modes = input.supportedModes;
  if (input.defaultLrtLimit !== undefined) updates.default_lrt_limit = input.defaultLrtLimit;
  if (input.defaultTimeLimitMinutes !== undefined)
    updates.default_time_limit_minutes = input.defaultTimeLimitMinutes;
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
