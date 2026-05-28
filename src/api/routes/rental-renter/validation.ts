import type {
  BudgetExtensionApprovalInput,
  BudgetExtensionDenialInput,
  BudgetExtensionRequestInput,
} from "../../rental/budget-extension.js";

export function isRentEnabled(): boolean {
  const v = process.env.LETAGENTS_RENT_ENABLED ?? "";
  return /^(1|true|yes)$/i.test(v.trim());
}

// ===== D3 trigger context validators (p1.7) =====
//
// The shape of `start_trigger`, `trigger_confidence`, and the renter
// lane fields is defined in spec §19.2 (rental_sessions D3 columns).
// We validate at the route boundary so malformed input never reaches
// the service or the DB enum check (which would 500 instead of 400).

export const RENTAL_START_TRIGGERS = [
  "quota_exhausted",
  "user_initiated",
  "scheduled",
  "task_handoff",
] as const;
export type RentalStartTrigger = (typeof RENTAL_START_TRIGGERS)[number];

export const RENTAL_TRIGGER_CONFIDENCES = [
  "exact",
  "inferred",
  "manual",
] as const;
export type RentalTriggerConfidence = (typeof RENTAL_TRIGGER_CONFIDENCES)[number];

export function isRentalStartTrigger(value: unknown): value is RentalStartTrigger {
  return typeof value === "string"
    && (RENTAL_START_TRIGGERS as readonly string[]).includes(value);
}

export function isRentalTriggerConfidence(
  value: unknown,
): value is RentalTriggerConfidence {
  return typeof value === "string"
    && (RENTAL_TRIGGER_CONFIDENCES as readonly string[]).includes(value);
}

/**
 * Parsed renter-side trigger context. Returned by
 * {@link parseTriggerContext} as a discriminated success/error so the
 * route handler can either forward it to the service or 400 the caller.
 */
export type ParsedTriggerContext =
  | { ok: true; value: TriggerContext }
  | { ok: false; error: string };

interface TriggerContext {
  startTrigger?: RentalStartTrigger;
  triggerConfidence?: RentalTriggerConfidence;
  renterLaneProvider?: string;
  renterLaneModel?: string;
  renterLaneExhaustedAt?: Date;
  renterLaneRefreshEta?: Date;
  renterQuotaSignal?: Record<string, unknown>;
}

export function parseIsoDateOrError(
  value: unknown,
  field: string,
): { ok: true; value: Date } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${field} must be an ISO-8601 timestamp string` };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `${field} is not a valid ISO-8601 timestamp` };
  }
  return { ok: true, value: new Date(ms) };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePositiveLrt(
  body: Record<string, unknown>,
  field: string,
): number | { error: string } {
  const value = body[field];
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value <= 0
  ) {
    return { error: `${field} must be a finite positive integer` };
  }
  return value;
}

export function parseOptionalText(
  body: Record<string, unknown>,
  field: string,
): string | undefined | { error: string } {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    return { error: `${field} must be a string` };
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function parseBudgetExtensionRequest(
  body: unknown,
): BudgetExtensionRequestInput | { error: string } {
  if (!isPlainObject(body)) return { error: "body must be an object" };
  const requestedAdditionalLrt = parsePositiveLrt(body, "requestedAdditionalLrt");
  if (typeof requestedAdditionalLrt !== "number") return requestedAdditionalLrt;
  const reason = parseOptionalText(body, "reason");
  if (typeof reason === "object") return reason;
  return { requestedAdditionalLrt, reason };
}

export function parseBudgetExtensionApproval(
  body: unknown,
): BudgetExtensionApprovalInput | { error: string } {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) return { error: "body must be an object" };

  let approvedAdditionalLrt: number | undefined;
  if (body.approvedAdditionalLrt !== undefined && body.approvedAdditionalLrt !== null) {
    const parsed = parsePositiveLrt(body, "approvedAdditionalLrt");
    if (typeof parsed !== "number") return parsed;
    approvedAdditionalLrt = parsed;
  }
  const note = parseOptionalText(body, "note");
  if (typeof note === "object") return note;
  return { approvedAdditionalLrt, note };
}

export function parseBudgetExtensionDenial(
  body: unknown,
): BudgetExtensionDenialInput | { error: string } {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) return { error: "body must be an object" };
  const reason = parseOptionalText(body, "reason");
  if (typeof reason === "object") return reason;
  return { reason };
}

export function parsePatchReviewNote(
  body: unknown,
): { note?: string | null } | { error: string } {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) return { error: "body must be an object" };
  const note = parseOptionalText(body, "note");
  if (typeof note === "object") return note;
  return { note: note ?? null };
}

/**
 * Parse + validate the D3 trigger-context fields from a session-create
 * request body. Returns a structured success or a 400-quality error.
 * Exported for unit tests; the route uses it directly.
 */
export function parseTriggerContext(body: Record<string, unknown>): ParsedTriggerContext {
  const ctx: TriggerContext = {};

  if (body.startTrigger !== undefined && body.startTrigger !== null) {
    if (!isRentalStartTrigger(body.startTrigger)) {
      return {
        ok: false,
        error: `startTrigger must be one of: ${RENTAL_START_TRIGGERS.join(", ")}`,
      };
    }
    ctx.startTrigger = body.startTrigger;
  }

  if (body.triggerConfidence !== undefined && body.triggerConfidence !== null) {
    if (!isRentalTriggerConfidence(body.triggerConfidence)) {
      return {
        ok: false,
        error: `triggerConfidence must be one of: ${RENTAL_TRIGGER_CONFIDENCES.join(", ")}`,
      };
    }
    ctx.triggerConfidence = body.triggerConfidence;
  }

  if (body.renterLaneProvider !== undefined && body.renterLaneProvider !== null) {
    if (typeof body.renterLaneProvider !== "string" || !body.renterLaneProvider.trim()) {
      return { ok: false, error: "renterLaneProvider must be a non-empty string" };
    }
    ctx.renterLaneProvider = body.renterLaneProvider.trim();
  }

  if (body.renterLaneModel !== undefined && body.renterLaneModel !== null) {
    if (typeof body.renterLaneModel !== "string" || !body.renterLaneModel.trim()) {
      return { ok: false, error: "renterLaneModel must be a non-empty string" };
    }
    ctx.renterLaneModel = body.renterLaneModel.trim();
  }

  if (body.renterLaneExhaustedAt !== undefined && body.renterLaneExhaustedAt !== null) {
    const parsed = parseIsoDateOrError(body.renterLaneExhaustedAt, "renterLaneExhaustedAt");
    if (!parsed.ok) return parsed;
    ctx.renterLaneExhaustedAt = parsed.value;
  }

  if (body.renterLaneRefreshEta !== undefined && body.renterLaneRefreshEta !== null) {
    const parsed = parseIsoDateOrError(body.renterLaneRefreshEta, "renterLaneRefreshEta");
    if (!parsed.ok) return parsed;
    ctx.renterLaneRefreshEta = parsed.value;
  }

  if (body.renterQuotaSignal !== undefined && body.renterQuotaSignal !== null) {
    if (!isPlainObject(body.renterQuotaSignal)) {
      return { ok: false, error: "renterQuotaSignal must be a JSON object" };
    }
    ctx.renterQuotaSignal = body.renterQuotaSignal;
  }

  // §19.2 cross-field consistency: when the renter signals an exhausted
  // lane, we want at least the provider + start_trigger so the server
  // can later index, attribute, and emit lane.exhausted events. This is
  // a soft requirement (warning-quality), enforced strictly here so
  // partially-populated D3 records don't slip through.
  if (ctx.renterLaneExhaustedAt && !ctx.renterLaneProvider) {
    return {
      ok: false,
      error: "renterLaneProvider is required when renterLaneExhaustedAt is set",
    };
  }
  if (ctx.renterLaneExhaustedAt && !ctx.startTrigger) {
    return {
      ok: false,
      error: "startTrigger is required when renterLaneExhaustedAt is set",
    };
  }

  return { ok: true, value: ctx };
}
