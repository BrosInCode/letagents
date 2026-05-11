/**
 * Desktop-side API mapper (p1.8b).
 *
 * Converts the snake_case row shapes the rental REST API returns
 * into the `DesktopRental*` camelCase shapes the renderer expects.
 *
 * Pure functions over `unknown` inputs (since `RentalApiClient`
 * returns `unknown` bodies). Defensive about missing / malformed
 * fields — every mapper has a sensible fallback so a partially
 * shaped server response never throws.
 *
 * Scope of this slice:
 *   • mapApiListing      — `/api/rental/provider/listings` row
 *   • mapApiSession      — `/api/rental/sessions/:id` row
 *   • mapApiRequest      — provider-side `/requests` row
 *   • mapApiActivityEvent — `rental_activity_events` row (for
 *                           future `desktop:rental:get-activity`)
 *   • mapApiPublicListing — renter-facing `/api/rental/listings`
 *                           row (already redacted by the server)
 *
 * Out of scope (lands in p1.8c with the handler wiring):
 *   • Plugging these mappers into `rental-handlers.ts`. The
 *     handlers in this commit still return their stub shapes.
 *
 * Spec refs:
 *   §19  rental_sessions / rental_listings / rental_activity_events
 *        schema and field meanings
 *   §22  Available-to-rent UX (DesktopRentalListing display fields)
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p1.8b.
 */

import type {
  DesktopRentalActivityEvent,
  DesktopRentalActivitySource,
  DesktopRentalActivityVisibility,
  DesktopRentalContinuityIngestDepth,
  DesktopRentalContinuityMode,
  DesktopRentalIdeKind,
  DesktopRentalListing,
  DesktopRentalListingStatus,
  DesktopRentalMeterConfidence,
  DesktopRentalMode,
  DesktopRentalNativeQuotaUnit,
  DesktopRentalPolicy,
  DesktopRentalQuotaLease,
  DesktopRentalQuotaSnapshot,
  DesktopRentalRequest,
  DesktopRentalScope,
  DesktopRentalSession,
  DesktopRentalSessionStatus,
  DesktopRentalStartInput,
  DesktopRentalStartTrigger,
  DesktopRentalTriggerConfidence,
  DesktopRentalVerificationStatus,
} from "../ipc-types.js";

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function readNumber(
  source: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function readBool(
  source: Record<string, unknown>,
  fallback: boolean,
  ...keys: string[]
): boolean {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }
  return fallback;
}

function readStringArray(
  source: Record<string, unknown>,
  ...keys: string[]
): string[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === "string");
    }
  }
  return [];
}

function readJsonObject(
  source: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = source[key];
    if (isObject(value)) return value;
  }
  return null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

function nonNullIso(value: unknown, fallback: string): string {
  return isoOrNull(value) ?? fallback;
}

// ---------------------------------------------------------------------------
// Enum coercion
// ---------------------------------------------------------------------------

const LISTING_STATUSES: readonly DesktopRentalListingStatus[] = [
  "active",
  "paused",
  "disabled",
  "setup_required",
];

const VERIFICATION_STATUSES: readonly DesktopRentalVerificationStatus[] = [
  "verified",
  "partially_verified",
  "experimental",
  "unreachable",
];

const METER_CONFIDENCES: readonly DesktopRentalMeterConfidence[] = [
  "official_exact",
  "local_exact",
  "derived",
  "calibrated",
  "estimated",
  "weak_estimate",
  "unknown",
];

const NATIVE_UNITS: readonly DesktopRentalNativeQuotaUnit[] = [
  "tokens",
  "credits",
  "usd",
  "requests",
  "percent_window",
  "time",
  "unknown",
];

const SESSION_STATUSES: readonly DesktopRentalSessionStatus[] = [
  "requested",
  "accepted",
  "provisioning",
  "active",
  "blocked",
  "patch_review",
  "pr_opened",
  "budget_exhausted",
  "stale",
  "completed",
  "cancelled",
  "expired",
  "failed",
];

const MODES: readonly DesktopRentalMode[] = ["scoped", "trusted_open"];
const CONTINUITY_MODES: readonly DesktopRentalContinuityMode[] = [
  "smart_handoff",
  "full_transcript",
];
const CONTINUITY_INGEST_DEPTHS: readonly DesktopRentalContinuityIngestDepth[] = [
  "tier_1",
  "tier_2",
];
const START_TRIGGERS: readonly DesktopRentalStartTrigger[] = [
  "quota_exhausted",
  "user_initiated",
  "scheduled",
  "task_handoff",
];
const TRIGGER_CONFIDENCES: readonly DesktopRentalTriggerConfidence[] = [
  "exact",
  "inferred",
  "manual",
];
const ACTIVITY_SOURCES: readonly DesktopRentalActivitySource[] = [
  "agent",
  "tool",
  "patch_gate",
  "system",
  "renter",
  "provider",
];
const ACTIVITY_VISIBILITIES: readonly DesktopRentalActivityVisibility[] = [
  "renter",
  "provider",
  "both",
  "internal",
  "rental_visible",
];

function coerceFromList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// QuotaSnapshot (used by listings, sessions, and standalone refresh)
// ---------------------------------------------------------------------------

export function mapApiQuotaSnapshot(raw: unknown): DesktopRentalQuotaSnapshot | null {
  if (!isObject(raw)) return null;
  return {
    id: readString(raw, "id", "snapshot_id"),
    provider: (readString(raw, "provider", "ide_kind") ?? "unknown") as DesktopRentalIdeKind,
    modelLabel: readString(raw, "model", "model_label", "modelLabel"),
    quotaLaneId: readString(raw, "quota_lane_id", "quotaLaneId", "lane_id"),
    quotaLaneLabel: readString(raw, "quota_lane_label", "quotaLaneLabel"),
    nativeUnit: coerceFromList(
      raw.native_unit ?? raw.nativeUnit,
      NATIVE_UNITS,
      "unknown",
    ),
    nativeUsed: readNumber(raw, "native_used", "nativeUsed"),
    nativeRemaining: readNumber(raw, "native_remaining", "nativeRemaining"),
    nativeLimit: readNumber(raw, "native_limit", "nativeLimit", "native_total", "nativeTotal"),
    nativeResetAt: isoOrNull(raw.native_reset_at ?? raw.nativeResetAt),
    nativeExpiresAt: isoOrNull(raw.native_expires_at ?? raw.nativeExpiresAt),
    inputTokens: readNumber(raw, "input_tokens", "inputTokens"),
    outputTokens: readNumber(raw, "output_tokens", "outputTokens"),
    cacheCreationTokens: readNumber(
      raw,
      "cache_creation_tokens",
      "cacheCreationTokens",
    ),
    cacheReadTokens: readNumber(raw, "cache_read_tokens", "cacheReadTokens"),
    reasoningTokens: readNumber(raw, "reasoning_tokens", "reasoningTokens"),
    lrtEstimate: readNumber(raw, "lrt_estimate", "lrtEstimate"),
    lrtRemaining: readNumber(raw, "lrt_remaining", "lrtRemaining"),
    confidence: coerceFromList(
      raw.confidence ?? raw.meter_confidence,
      METER_CONFIDENCES,
      "unknown",
    ),
    source: readString(raw, "source", "source_id", "sourceId"),
    observedAt: nonNullIso(raw.observed_at ?? raw.observedAt, new Date().toISOString()),
    stale: readBool(raw, false, "stale"),
    raw: readJsonObject(raw, "raw"),
  };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export function mapApiListing(raw: unknown): DesktopRentalListing | null {
  if (!isObject(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  return {
    id,
    providerAccountId: readString(raw, "provider_account_id", "providerAccountId"),
    providerDisplayName: readString(
      raw,
      "provider_display_name",
      "providerDisplayName",
    ),
    displayName: readString(raw, "display_name", "displayName") ?? "Rental listing",
    status: coerceFromList(raw.status, LISTING_STATUSES, "setup_required"),
    verificationStatus: coerceFromList(
      raw.verification_status ?? raw.verificationStatus,
      VERIFICATION_STATUSES,
      "experimental",
    ),
    readinessBadges: readStringArray(raw, "readiness_badges", "readinessBadges"),
    readiness: null, // Server doesn't currently return the readiness object inline.
    ideKind: (readString(raw, "ide_kind", "ideKind") ?? "unknown") as DesktopRentalIdeKind,
    modelLabel: readString(raw, "model_label", "modelLabel"),
    quotaLaneId: readString(raw, "quota_lane_id", "quotaLaneId"),
    quotaLaneLabel: readString(raw, "quota_lane_label", "quotaLaneLabel"),
    meterConfidence: coerceFromList(
      raw.meter_confidence ?? raw.meterConfidence,
      METER_CONFIDENCES,
      "unknown",
    ),
    nativeQuotaUnit: coerceFromList(
      raw.native_quota_unit ?? raw.nativeQuotaUnit,
      NATIVE_UNITS,
      "unknown",
    ),
    lastNativeQuotaSnapshot: mapApiQuotaSnapshot(
      raw.last_native_quota_snapshot ?? raw.lastNativeQuotaSnapshot,
    ),
    lastLrtEstimate: readNumber(raw, "last_lrt_estimate", "lastLrtEstimate"),
    lastQuotaResetAt: isoOrNull(raw.last_quota_reset_at ?? raw.lastQuotaResetAt),
    verifiedAgentFingerprintId: readString(
      raw,
      "verified_agent_fingerprint_id",
      "verifiedAgentFingerprintId",
    ),
    supportedModes: (readStringArray(
      raw,
      "supported_modes",
      "supportedModes",
    ).filter((m) => (MODES as readonly string[]).includes(m)) as DesktopRentalMode[]),
    maxConcurrentSessions:
      readNumber(raw, "max_concurrent_sessions", "maxConcurrentSessions") ?? 1,
    activeSessionCount:
      readNumber(raw, "active_session_count", "activeSessionCount") ?? 0,
    defaultLrtLimit: readNumber(raw, "default_lrt_limit", "defaultLrtLimit"),
    defaultTimeLimitMinutes: readNumber(
      raw,
      "default_time_limit_minutes",
      "defaultTimeLimitMinutes",
    ),
    manualAcceptRequired: readBool(
      raw,
      true,
      "manual_accept_required",
      "manualAcceptRequired",
    ),
    createdAt: isoOrNull(raw.created_at ?? raw.createdAt),
    updatedAt: nonNullIso(raw.updated_at ?? raw.updatedAt, new Date().toISOString()),
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function mapApiScope(raw: unknown): DesktopRentalScope {
  const obj = isObject(raw) ? raw : {};
  return {
    includePaths: readStringArray(obj, "include_paths", "includePaths"),
    excludePaths: readStringArray(obj, "exclude_paths", "excludePaths"),
    protectedPaths: readStringArray(obj, "protected_paths", "protectedPaths"),
    notes: readString(obj, "notes"),
  };
}

function mapApiPolicy(raw: unknown): DesktopRentalPolicy {
  const obj = isObject(raw) ? raw : {};
  return {
    maxLrt: readNumber(obj, "max_lrt", "maxLrt"),
    maxDurationMinutes: readNumber(
      obj,
      "max_duration_minutes",
      "maxDurationMinutes",
    ),
    maxPatchBytes: readNumber(obj, "max_patch_bytes", "maxPatchBytes"),
    allowCommands: readBool(obj, false, "allow_commands", "allowCommands"),
    allowNetwork: readBool(obj, false, "allow_network", "allowNetwork"),
    requirePatchGate: readBool(
      obj,
      true,
      "require_patch_gate",
      "requirePatchGate",
    ),
  };
}

function mapApiQuotaLease(raw: unknown): DesktopRentalQuotaLease | null {
  if (!isObject(raw)) return null;
  // The server-side lease shape (per p2.9a/b) has `lockedAt`,
  // `lastRefreshedAt`, `lane`, `snapshot`. The desktop's
  // DesktopRentalQuotaLease shape predates that and uses a flatter
  // (id, laneId, lrtLimit, …) layout. Map what we can; expose null
  // for the lifecycle-only fields the desktop UI doesn't render yet.
  return {
    id: readString(raw, "id", "session_id", "sessionId") ?? "lease",
    laneId:
      readString(raw, "lane_id", "laneId")
      ?? (isObject(raw.lane) ? readString(raw.lane, "quota_lane_id", "quotaLaneId") : null),
    lrtLimit: readNumber(raw, "lrt_limit", "lrtLimit"),
    lrtReserved: readNumber(raw, "lrt_reserved", "lrtReserved") ?? 0,
    lrtUsed: readNumber(raw, "lrt_used", "lrtUsed") ?? 0,
    expiresAt: isoOrNull(raw.expires_at ?? raw.expiresAt ?? raw.released_at),
    updatedAt: isoOrNull(
      raw.updated_at
      ?? raw.updatedAt
      ?? raw.last_refreshed_at
      ?? raw.lastRefreshedAt,
    ),
  };
}

export function mapApiSession(raw: unknown): DesktopRentalSession | null {
  if (!isObject(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  return {
    id,
    listingId: readString(raw, "listing_id", "listingId") ?? "",
    renterAccountId: readString(raw, "renter_account_id", "renterAccountId"),
    providerAccountId: readString(raw, "provider_account_id", "providerAccountId"),
    roomIdentifier: readString(raw, "room_id", "roomId", "room_identifier"),
    repoProvider: readString(raw, "repo_provider", "repoProvider"),
    repoOwner: readString(raw, "repo_owner", "repoOwner"),
    repoName: readString(raw, "repo_name", "repoName"),
    baseBranch: readString(raw, "base_branch", "baseBranch"),
    workBranch: readString(raw, "work_branch", "workBranch"),
    taskTitle: readString(raw, "task_title", "taskTitle") ?? "",
    taskPrompt: readString(raw, "task_prompt", "taskPrompt") ?? "",
    mode: coerceFromList(raw.mode, MODES, "scoped"),
    continuityMode: coerceFromList(
      raw.continuity_mode ?? raw.continuityMode,
      CONTINUITY_MODES,
      "smart_handoff",
    ),
    continuityIngestDepth: coerceFromList(
      raw.continuity_ingest_depth ?? raw.continuityIngestDepth,
      CONTINUITY_INGEST_DEPTHS,
      "tier_1",
    ),
    continuityPackId:
      readString(raw, "continuity_pack_id", "continuityPackId")
      ?? (isObject(raw.continuity_pack)
        ? readString(raw.continuity_pack, "packId", "pack_id", "id")
        : null),
    status: coerceFromList(raw.status, SESSION_STATUSES, "requested"),
    approvedScope: mapApiScope(raw.approved_scope ?? raw.approvedScope),
    policy: mapApiPolicy(raw.policy),
    quotaLease: mapApiQuotaLease(raw.quota_lease ?? raw.quotaLease),
    nativeQuotaUnit: coerceFromList(
      raw.native_quota_unit ?? raw.nativeQuotaUnit,
      NATIVE_UNITS,
      "unknown",
    ),
    nativeQuotaStartSnapshot: mapApiQuotaSnapshot(
      raw.native_quota_start_snapshot ?? raw.nativeQuotaStartSnapshot,
    ),
    nativeQuotaLatestSnapshot: mapApiQuotaSnapshot(
      raw.native_quota_latest_snapshot ?? raw.nativeQuotaLatestSnapshot,
    ),
    meterConfidence: coerceFromList(
      raw.meter_confidence ?? raw.meterConfidence,
      METER_CONFIDENCES,
      "unknown",
    ),
    lrtLimit: readNumber(raw, "lrt_limit", "lrtLimit"),
    lrtReserved: readNumber(raw, "lrt_reserved", "lrtReserved") ?? 0,
    lrtUsed: readNumber(raw, "lrt_used", "lrtUsed") ?? 0,
    lrtRemaining: readNumber(raw, "lrt_remaining", "lrtRemaining"),
    budgetStopThreshold: readNumber(
      raw,
      "budget_stop_threshold",
      "budgetStopThreshold",
    ),
    timeLimitMinutes: readNumber(
      raw,
      "time_limit_minutes",
      "timeLimitMinutes",
    ),
    startTrigger: coerceFromListOrNull(
      raw.start_trigger ?? raw.startTrigger,
      START_TRIGGERS,
    ),
    triggerConfidence: coerceFromListOrNull(
      raw.trigger_confidence ?? raw.triggerConfidence,
      TRIGGER_CONFIDENCES,
    ),
    renterLaneExhaustedAt: isoOrNull(
      raw.renter_lane_exhausted_at ?? raw.renterLaneExhaustedAt,
    ),
    renterLaneProvider: readString(
      raw,
      "renter_lane_provider",
      "renterLaneProvider",
    ),
    renterLaneModel: readString(raw, "renter_lane_model", "renterLaneModel"),
    renterLaneRefreshEta: isoOrNull(
      raw.renter_lane_refresh_eta ?? raw.renterLaneRefreshEta,
    ),
    renterQuotaSignal: readJsonObject(
      raw,
      "renter_quota_signal",
      "renterQuotaSignal",
    ),
    renterLaneRecoveredAt: isoOrNull(
      raw.renter_lane_recovered_at ?? raw.renterLaneRecoveredAt,
    ),
    startedAt: isoOrNull(raw.started_at ?? raw.startedAt),
    endedAt: isoOrNull(raw.ended_at ?? raw.endedAt),
    createdAt: isoOrNull(raw.created_at ?? raw.createdAt),
    updatedAt: nonNullIso(raw.updated_at ?? raw.updatedAt, new Date().toISOString()),
  };
}

function coerceFromListOrNull<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// Activity event
// ---------------------------------------------------------------------------

export function mapApiActivityEvent(
  raw: unknown,
): DesktopRentalActivityEvent | null {
  if (!isObject(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  return {
    id,
    sessionId: readString(raw, "session_id", "sessionId") ?? "",
    roomIdentifier: readString(raw, "room_id", "roomId", "room_identifier"),
    eventType: readString(raw, "event_type", "eventType") ?? "unknown",
    source: coerceFromList(raw.source, ACTIVITY_SOURCES, "system"),
    verified: readBool(raw, false, "verified"),
    visibility: coerceFromList(
      raw.visibility,
      ACTIVITY_VISIBILITIES,
      "rental_visible",
    ),
    payload: readJsonObject(raw, "payload") ?? {},
    createdAt: nonNullIso(raw.created_at ?? raw.createdAt, new Date().toISOString()),
  };
}

// ---------------------------------------------------------------------------
// Array helpers
// ---------------------------------------------------------------------------

/**
 * Map an envelope or bare array of API listing rows into desktop
 * shapes. Accepts:
 *   • `[{...}, {...}]`
 *   • `{ listings: [{...}, ...] }`
 */
export function mapApiListingArray(raw: unknown): DesktopRentalListing[] {
  const rows = unwrapArray(raw, "listings");
  return rows
    .map((row) => mapApiListing(row))
    .filter((x): x is DesktopRentalListing => x !== null);
}

export function mapApiRequestArray(raw: unknown): DesktopRentalRequest[] {
  const rows = unwrapArray(raw, "requests");
  return rows
    .map((row) => mapApiRequest(row))
    .filter((x): x is DesktopRentalRequest => x !== null);
}

export function mapApiActivityEventArray(
  raw: unknown,
): DesktopRentalActivityEvent[] {
  const rows = unwrapArray(raw, "events", "activity");
  return rows
    .map((row) => mapApiActivityEvent(row))
    .filter((x): x is DesktopRentalActivityEvent => x !== null);
}

function unwrapArray(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isObject(raw)) {
    for (const key of keys) {
      const value = raw[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Outbound: Desktop input → API body
// ---------------------------------------------------------------------------

/**
 * Convert a `DesktopRentalStartInput` (renderer-side payload for
 * `desktop:rental:create-session`) into the body shape the server's
 * `POST /api/rental/sessions` expects.
 *
 * Only forwards fields that are actually set. Lets the route
 * apply its own defaults (mode → "scoped", continuityMode →
 * "smart_handoff") rather than echoing partial inputs.
 *
 * `lrtLimit` and `timeLimitMinutes` are lifted out of the
 * renderer's `policy` envelope because the API surfaces them at
 * the top level.
 *
 * Spec ref: §6.2 renter session-create flow + §19.2 rental_sessions
 * D3 columns.
 */
export function toApiCreateSessionBody(
  input: Partial<DesktopRentalStartInput>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const passThrough: Array<keyof DesktopRentalStartInput> = [
    "listingId",
    "repoOwner",
    "repoName",
    "baseBranch",
    "taskTitle",
    "taskPrompt",
    "mode",
    "continuityMode",
    "startTrigger",
    "triggerConfidence",
    "renterLaneProvider",
    "renterLaneModel",
    "renterLaneExhaustedAt",
    "renterLaneRefreshEta",
    "renterQuotaSignal",
  ];
  for (const key of passThrough) {
    const value = input[key];
    if (value !== undefined && value !== null) {
      body[key as string] = value;
    }
  }
  const policy = input.policy;
  if (policy) {
    if (typeof policy.maxLrt === "number" && Number.isFinite(policy.maxLrt)) {
      body.lrtLimit = policy.maxLrt;
    }
    if (
      typeof policy.maxDurationMinutes === "number"
      && Number.isFinite(policy.maxDurationMinutes)
    ) {
      body.timeLimitMinutes = policy.maxDurationMinutes;
    }
  }
  return body;
}
