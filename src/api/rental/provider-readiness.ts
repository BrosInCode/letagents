/**
 * Provider-level readiness projector (p2.14).
 *
 * V1 semantics: project the caller's `rental_listings` rows into a
 * `ApiProviderReadiness` shape that mirrors `DesktopRentalProviderReadiness`.
 * The status rollup is purely a function of listing status counts:
 *
 *   - `ready`     — at least one active listing, no setup_required ones
 *   - `degraded`  — has active listings but also setup_required or disabled
 *                  (or only paused listings — provider is configured but
 *                   not currently renting)
 *   - `blocked`   — has listings but none are active or paused
 *                  (everything is disabled or stuck in setup_required)
 *   - `unknown`   — no listings at all
 *
 * Future work (post-V1) can layer real checks here: provider's MCP
 * server reachable, GitHub token still valid, adapter heartbeats
 * recent, etc. The `checks` array is shaped for that growth path.
 *
 * Spec ref: §22 (Available-to-rent UX) — readiness rollup is the
 * provider dashboard's at-a-glance "can I rent?" signal.
 */

import type { rental_listings } from "../db/schema.js";

type ListingRow = typeof rental_listings.$inferSelect;

export type ApiProviderReadinessStatus =
  | "ready"
  | "degraded"
  | "blocked"
  | "unknown";

export type ApiProviderReadinessCheckStatus =
  | "passed"
  | "warning"
  | "failed"
  | "unknown";

export interface ApiProviderReadinessCheck {
  id: string;
  label: string;
  status: ApiProviderReadinessCheckStatus;
  detail: string | null;
}

export interface ApiProviderReadiness {
  status: ApiProviderReadinessStatus;
  summary: string | null;
  blockers: string[];
  warnings: string[];
  badges: string[];
  checks: ApiProviderReadinessCheck[];
  last_checked_at: string;
}

interface StatusCounts {
  active: number;
  paused: number;
  disabled: number;
  setup_required: number;
}

function countByStatus(listings: ListingRow[]): StatusCounts {
  const counts: StatusCounts = {
    active: 0,
    paused: 0,
    disabled: 0,
    setup_required: 0,
  };
  for (const listing of listings) {
    if (listing.status in counts) {
      counts[listing.status as keyof StatusCounts] += 1;
    }
  }
  return counts;
}

function rollupStatus(counts: StatusCounts, total: number): ApiProviderReadinessStatus {
  if (total === 0) return "unknown";
  if (counts.active > 0 && counts.setup_required === 0) return "ready";
  if (counts.active > 0 || counts.paused > 0) return "degraded";
  return "blocked";
}

function checkStatusFor(
  listingStatus: ListingRow["status"],
): ApiProviderReadinessCheckStatus {
  switch (listingStatus) {
    case "active":
      return "passed";
    case "paused":
      return "warning";
    case "disabled":
      return "failed";
    case "setup_required":
      return "warning";
    default:
      return "unknown";
  }
}

function checkDetailFor(listingStatus: ListingRow["status"]): string | null {
  switch (listingStatus) {
    case "active":
      return "Listing is accepting rental requests.";
    case "paused":
      return "Listing is paused. Resume to accept new requests.";
    case "disabled":
      return "Listing is disabled. Re-enable from settings.";
    case "setup_required":
      return "Listing needs setup before it can accept requests.";
    default:
      return null;
  }
}

function summarize(counts: StatusCounts, total: number): string {
  if (total === 0) return "No listings yet — create one to start renting.";
  const parts: string[] = [];
  if (counts.active) parts.push(`${counts.active} active`);
  if (counts.paused) parts.push(`${counts.paused} paused`);
  if (counts.setup_required) parts.push(`${counts.setup_required} need setup`);
  if (counts.disabled) parts.push(`${counts.disabled} disabled`);
  return `${total} listing${total === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}

function uniqueBadges(listings: ListingRow[]): string[] {
  const seen = new Set<string>();
  for (const listing of listings) {
    const badges = listing.readiness_badges;
    if (!Array.isArray(badges)) continue;
    for (const badge of badges) {
      if (typeof badge === "string" && badge.length > 0) {
        seen.add(badge);
      }
    }
  }
  return [...seen].sort();
}

/**
 * Project a provider's listings into the readiness summary. Pure
 * function so it's unit-testable without touching the DB.
 */
export function projectProviderReadiness(
  listings: ListingRow[],
  now: Date = new Date(),
): ApiProviderReadiness {
  const total = listings.length;
  const counts = countByStatus(listings);
  const status = rollupStatus(counts, total);

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (status === "blocked") {
    blockers.push("No active listings — every listing is either disabled or pending setup.");
  } else if (counts.setup_required > 0) {
    warnings.push(`${counts.setup_required} listing${counts.setup_required === 1 ? "" : "s"} need setup.`);
  }
  if (counts.paused > 0 && status === "ready") {
    warnings.push(`${counts.paused} listing${counts.paused === 1 ? "" : "s"} paused.`);
  }

  const checks: ApiProviderReadinessCheck[] = listings.map((listing) => ({
    id: `listing:${listing.id}`,
    label: listing.display_name,
    status: checkStatusFor(listing.status),
    detail: checkDetailFor(listing.status),
  }));

  return {
    status,
    summary: summarize(counts, total),
    blockers,
    warnings,
    badges: uniqueBadges(listings),
    checks,
    last_checked_at: now.toISOString(),
  };
}
