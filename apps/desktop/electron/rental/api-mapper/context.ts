import type {
  DesktopRentalContextApproval,
  DesktopRentalExposure,
} from "../../ipc-types.js";

import {
  coerceFromList,
  isObject,
  isoOrNull,
  nonNullIso,
  readNumber,
  readString,
} from "./primitives.js";

// ---------------------------------------------------------------------------
// Exposure ledger entries + context access requests
// ---------------------------------------------------------------------------

const EXPOSURE_TYPES = [
  "file",
  "search_result",
  "directory_listing",
  "command_output",
] as const;

const SECRET_SCAN_STATUSES = ["passed", "redacted", "blocked"] as const;

const CONTEXT_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
] as const;

export function mapApiExposure(raw: unknown): DesktopRentalExposure | null {
  if (!isObject(raw)) return null;
  const id = readString(raw, "id");
  const path = readString(raw, "path");
  if (!id || !path) return null;
  return {
    id,
    sessionId: readString(raw, "session_id", "sessionId") ?? "",
    path,
    exposureType: coerceFromList(
      raw.exposure_type ?? raw.exposureType,
      EXPOSURE_TYPES,
      "file",
    ),
    reason: readString(raw, "reason"),
    redactionCount: readNumber(raw, "redaction_count", "redactionCount") ?? 0,
    secretScanStatus: coerceFromList(
      raw.secret_scan_status ?? raw.secretScanStatus,
      SECRET_SCAN_STATUSES,
      "passed",
    ),
    requestedBy: readString(raw, "requested_by", "requestedBy"),
    approvedBy: readString(raw, "approved_by", "approvedBy"),
    scopeId: readString(raw, "scope_id", "scopeId"),
    createdAt: nonNullIso(raw.created_at ?? raw.createdAt, new Date().toISOString()),
  };
}

export function mapApiContextApproval(
  raw: unknown,
): DesktopRentalContextApproval | null {
  if (!isObject(raw)) return null;
  // Decision responses arrive as { request: {...}, materialized } envelopes.
  const row = isObject(raw.request) ? raw.request : raw;
  const id = readString(row, "id");
  if (!id) return null;
  return {
    id,
    sessionId: readString(row, "session_id", "sessionId") ?? "",
    requestType:
      readString(row, "request_type", "requestType") ?? "read_file",
    status: coerceFromList(row.status, CONTEXT_APPROVAL_STATUSES, "pending"),
    path: readString(row, "path"),
    reason: readString(row, "reason"),
    redactionCount: readNumber(row, "redaction_count", "redactionCount") ?? 0,
    requestedBy: readString(row, "requested_by", "requestedBy"),
    decidedBy: readString(row, "decided_by", "decidedBy"),
    createdAt: isoOrNull(row.created_at ?? row.createdAt),
    decidedAt: isoOrNull(row.decided_at ?? row.decidedAt),
    // Only decision envelopes carry the materialize outcome.
    materialized: typeof raw.materialized === "boolean" ? raw.materialized : null,
  };
}
