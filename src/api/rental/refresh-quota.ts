/**
 * Refresh-quota service — server-side (p2.13).
 *
 * The MCP tool `rental_refresh_quota` exposes a way for the rented
 * agent (or the renter's UI) to ask "what's the latest provider-side
 * quota snapshot you have for this session?".
 *
 * V1 semantics: server returns the latest `native_quota_latest_snapshot`
 * already stored on the session row by the adapter scheduler's
 * usage-ingest pipeline. The server cannot directly poke the
 * provider's desktop adapter from here — that would require a
 * push-to-desktop channel that doesn't exist in V1. Future work
 * (post-V1, see spec §6.4) could write a `refresh_quota_requested_at`
 * hint to the row and let the scheduler honor it on its next tick.
 *
 * The returned `refreshed` flag is `false` for now to make this
 * explicit. The MCP tool's `RentalRefreshQuotaResult` already
 * surfaces this as optional with a `true` default — the desktop
 * tool wrapper will see `false` and report "no new poll, returned
 * the cached snapshot" rather than implying a fresh read.
 *
 * Spec refs: §6.4 (native quota recovery), §17.7 (adapter pipeline).
 */

import type { rental_sessions } from "../db/schema.js";

type SessionRow = typeof rental_sessions.$inferSelect;

/**
 * Decision returned by {@link buildRefreshQuotaResponse}.
 *
 * `provider_match` reflects whether the optional provider hint
 * matched the session's renter lane provider. We pass through the
 * snapshot regardless (the MCP tool wants the freshest data
 * available), but the boolean lets callers/tests audit hint
 * usefulness.
 */
export interface RefreshQuotaResponse {
  snapshot: Record<string, unknown> | null;
  refreshed: boolean;
  provider_match: boolean | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure projector — given a session row and an optional provider
 * hint, returns the refresh-quota response shape.
 *
 * Exposed separately from the route handler so unit tests can drive
 * the decision logic without spinning up Express.
 */
export function buildRefreshQuotaResponse(
  session: SessionRow,
  providerHint: string | null,
): RefreshQuotaResponse {
  const rawSnapshot = session.native_quota_latest_snapshot;
  const snapshot = isObject(rawSnapshot) ? rawSnapshot : null;

  let providerMatch: boolean | null = null;
  if (providerHint) {
    const stored = session.renter_lane_provider;
    providerMatch = typeof stored === "string"
      ? stored.toLowerCase() === providerHint.toLowerCase()
      : false;
  }

  return {
    snapshot,
    refreshed: false,
    provider_match: providerMatch,
  };
}

/**
 * Parse the provider hint from the request body. Returns the
 * trimmed lowercased string when valid, null otherwise.
 *
 * Conservative validation: 64-char cap, non-empty after trim,
 * pure ASCII. Anything weirder is dropped silently to keep the
 * route from 400'ing on a hint (the hint is optional after all).
 */
export function parseProviderHint(body: unknown): string | null {
  if (!isObject(body)) return null;
  const value = body.provider;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (!/^[\x20-\x7E]+$/.test(trimmed)) return null;
  return trimmed;
}
