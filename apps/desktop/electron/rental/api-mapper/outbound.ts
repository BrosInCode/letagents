import type {
  DesktopRentalListingInput,
  DesktopRentalListingPatch,
  DesktopRentalStartInput,
  DesktopRentalTriggerConfidence,
} from "../../ipc-types.js";

// ---------------------------------------------------------------------------
// Outbound: Desktop input → API body
// ---------------------------------------------------------------------------

/**
 * Build the request body for `POST /api/rental/renter/declare-quota-exhausted`
 * from a local `DesktopRentalRenterTriggerSignal`. The desktop's
 * `RenterTriggerRuntime.declareManual` is the local source of truth;
 * the server endpoint exists only so other surfaces (web, MCP,
 * second desktop) can read the same declaration.
 *
 * Returns `null` when the local signal lacks a provider — the server
 * validator (`parseTriggerContext`) rejects declarations without it,
 * so we skip the network round-trip rather than 400 ourselves.
 *
 * The server enforces `startTrigger === "quota_exhausted"` on this
 * endpoint (see `rental-renter.ts` p2.6c), so it's hardcoded here.
 *
 * Spec ref: §6.5 renter quota mirror.
 */
export function toApiDeclareQuotaBody(
  signal: {
    provider: string | null;
    model: string | null;
    confidence: DesktopRentalTriggerConfidence | null;
    observedAt: string | null;
    rawSignal: Record<string, unknown> | null;
  },
): Record<string, unknown> | null {
  const provider = signal.provider?.trim();
  if (!provider) return null;
  const body: Record<string, unknown> = {
    startTrigger: "quota_exhausted",
    triggerConfidence: signal.confidence ?? "manual",
    renterLaneProvider: provider,
    renterLaneExhaustedAt:
      signal.observedAt ?? new Date().toISOString(),
  };
  const model = signal.model?.trim();
  if (model) body.renterLaneModel = model;
  if (signal.rawSignal && typeof signal.rawSignal === "object") {
    body.renterQuotaSignal = signal.rawSignal;
  }
  return body;
}

/**
 * Convert a `DesktopRentalStartInput` (renderer-side payload for
 * `desktop:rental:create-session`) into the body shape the server's
 * `POST /api/rental/sessions` expects.
 *
 * Only forwards fields that are actually set. Lets the route
 * apply its own defaults (mode → "scoped", continuityMode →
 * "smart_handoff") rather than echoing partial inputs.
 *
 * `approvedScope` and the `policy` envelope are forwarded for
 * persistence; `lrtLimit` and `timeLimitMinutes` are also lifted out
 * because the API surfaces those scheduling limits at the top level.
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
    "approvedScope",
  ];
  for (const key of passThrough) {
    const value = input[key];
    if (value !== undefined && value !== null) {
      body[key as string] = value;
    }
  }
  const policy = input.policy;
  if (policy) {
    body.policy = policy;
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

/**
 * Convert an outbound desktop listing create input into the API
 * request shape. The provider routes already accept camelCase keys,
 * so the mapper is a pass-through filter that drops `undefined` /
 * blank values and trims the user-visible string fields.
 */
export function toApiListingCreateBody(
  input: Partial<DesktopRentalListingInput>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof input.displayName === "string" && input.displayName.trim()) {
    body.displayName = input.displayName.trim();
  }
  if (typeof input.ideKind === "string" && input.ideKind.trim()) {
    body.ideKind = input.ideKind.trim();
  }
  const passThrough: Array<keyof DesktopRentalListingInput> = [
    "modelLabel",
    "quotaLaneId",
    "quotaLaneLabel",
    "supportedModes",
    "defaultLrtLimit",
    "defaultTimeLimitMinutes",
    "manualAcceptRequired",
    "maxConcurrentSessions",
  ];
  for (const key of passThrough) {
    const value = input[key];
    if (value !== undefined) body[key as string] = value;
  }
  return body;
}

/**
 * Convert an outbound desktop listing patch into the API request
 * shape. Same pass-through approach as `toApiListingCreateBody`, but
 * every field is optional.
 */
export function toApiListingPatchBody(
  input: Partial<DesktopRentalListingPatch>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.displayName !== undefined) {
    if (typeof input.displayName === "string" && input.displayName.trim()) {
      body.displayName = input.displayName.trim();
    }
  }
  const passThrough: Array<keyof DesktopRentalListingPatch> = [
    "modelLabel",
    "quotaLaneId",
    "quotaLaneLabel",
    "supportedModes",
    "defaultLrtLimit",
    "defaultTimeLimitMinutes",
    "manualAcceptRequired",
    "maxConcurrentSessions",
  ];
  for (const key of passThrough) {
    const value = input[key];
    if (value !== undefined) body[key as string] = value;
  }
  return body;
}
