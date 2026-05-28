import type { DesktopRentalRequest } from "../../ipc-types.js";

import { CONTINUITY_MODES, MODES } from "./enums.js";
import {
  coerceFromList,
  isObject,
  isoOrNull,
  nonNullIso,
  readNumber,
  readString,
} from "./primitives.js";

// ---------------------------------------------------------------------------
// Request (provider-side incoming request)
// ---------------------------------------------------------------------------

const REQUEST_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
] as const;
type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * Provider requests share the rental_sessions row in V1 — the
 * server returns the session shape and the desktop renders the
 * "pending request" view of it. Map the relevant fields.
 */
export function mapApiRequest(raw: unknown): DesktopRentalRequest | null {
  if (!isObject(raw)) return null;
  const sessionId = readString(raw, "id", "session_id", "sessionId");
  if (!sessionId) return null;
  const status: RequestStatus = (() => {
    const s = readString(raw, "status");
    if (s === "requested") return "pending";
    if (s && (REQUEST_STATUSES as readonly string[]).includes(s)) {
      return s as RequestStatus;
    }
    return "pending";
  })();
  return {
    id: readString(raw, "request_id", "requestId") ?? sessionId,
    sessionId,
    listingId: readString(raw, "listing_id", "listingId") ?? "",
    status,
    renterDisplayName: readString(
      raw,
      "renter_display_name",
      "renterDisplayName",
    ),
    providerDisplayName: readString(
      raw,
      "provider_display_name",
      "providerDisplayName",
    ),
    taskTitle: readString(raw, "task_title", "taskTitle") ?? "",
    taskPrompt: readString(raw, "task_prompt", "taskPrompt") ?? "",
    mode: coerceFromList(raw.mode, MODES, "scoped"),
    continuityMode: coerceFromList(
      raw.continuity_mode ?? raw.continuityMode,
      CONTINUITY_MODES,
      "smart_handoff",
    ),
    requestedLrtLimit: readNumber(
      raw,
      "requested_lrt_limit",
      "requestedLrtLimit",
      "lrt_limit",
      "lrtLimit",
    ),
    requestedTimeLimitMinutes: readNumber(
      raw,
      "requested_time_limit_minutes",
      "requestedTimeLimitMinutes",
      "time_limit_minutes",
      "timeLimitMinutes",
    ),
    createdAt: isoOrNull(raw.created_at ?? raw.createdAt),
    expiresAt: isoOrNull(raw.expires_at ?? raw.expiresAt),
    updatedAt: nonNullIso(raw.updated_at ?? raw.updatedAt, new Date().toISOString()),
  };
}
