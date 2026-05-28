import type {
  DesktopRentalPatch,
  DesktopRentalPatchCheckResult,
} from "../../ipc-types.js";

import {
  PATCH_CHECK_STATUSES,
  PATCH_GATE_STATUSES,
  PATCH_SOURCES,
} from "./enums.js";
import {
  coerceFromList,
  isObject,
  isoOrNull,
  nonNullIso,
  readNumber,
  readString,
} from "./primitives.js";

// ---------------------------------------------------------------------------
// Patch review
// ---------------------------------------------------------------------------

function readWarningMessages(...values: unknown[]): string[] {
  const messages: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        messages.push(item.trim());
      } else if (isObject(item)) {
        const message = readString(item, "message", "detail", "reason");
        if (message) messages.push(message);
      }
    }
  }
  return [...new Set(messages)];
}

function mapApiPatchCheckResult(
  raw: unknown,
  index: number,
): DesktopRentalPatchCheckResult | null {
  if (!isObject(raw)) return null;
  const directStatus = raw.status;
  if (typeof directStatus === "string") {
    return {
      id: readString(raw, "id") ?? `check_${index + 1}`,
      label: readString(raw, "label") ?? readString(raw, "file", "path") ?? `Check ${index + 1}`,
      status: coerceFromList(directStatus, PATCH_CHECK_STATUSES, "pending"),
      detail: readString(raw, "detail", "reason"),
      completedAt: isoOrNull(raw.completed_at ?? raw.completedAt),
    };
  }

  const file = readString(raw, "file", "path") ?? "patch";
  const operation = readString(raw, "operation") ?? "validate";
  const warnings = readWarningMessages(raw.warnings);
  const passed = raw.passed === true;
  const status: DesktopRentalPatchCheckResult["status"] = passed
    ? warnings.length > 0 ? "warning" : "passed"
    : "failed";
  return {
    id: `${operation}:${file}`,
    label: `${operation} ${file}`,
    status,
    detail: readString(raw, "reason") ?? (warnings.length ? warnings.join("\n") : null),
    completedAt: isoOrNull(raw.completed_at ?? raw.completedAt),
  };
}

function readPatchCheckRows(raw: Record<string, unknown>): unknown[] {
  const direct = raw.checkResults ?? raw.check_results;
  if (Array.isArray(direct)) return direct;
  if (isObject(direct) && Array.isArray(direct.checks)) return direct.checks;
  return [];
}

function readPatchReview(raw: Record<string, unknown>): Record<string, unknown> {
  const direct = raw.review;
  if (isObject(direct)) return direct;
  const checkResults = raw.checkResults ?? raw.check_results;
  if (isObject(checkResults) && isObject(checkResults.review)) return checkResults.review;
  return {};
}

export function mapApiPatch(raw: unknown): DesktopRentalPatch | null {
  const envelope = isObject(raw) && isObject(raw.patch) ? raw.patch : raw;
  if (!isObject(envelope)) return null;
  const id = readString(envelope, "id");
  if (!id) return null;

  const checkResultsRaw = envelope.checkResults ?? envelope.check_results;
  const checkResults = readPatchCheckRows(envelope)
    .map((row, index) => mapApiPatchCheckResult(row, index))
    .filter((row): row is DesktopRentalPatchCheckResult => row !== null);
  const review = readPatchReview(envelope);
  return {
    id,
    sessionId: readString(envelope, "session_id", "sessionId") ?? "",
    source: coerceFromList(
      envelope.source,
      PATCH_SOURCES,
      "explicit_patch",
    ),
    summary: readString(envelope, "summary"),
    diffRef: readString(envelope, "diff_ref", "diffRef"),
    diffPreview: readString(envelope, "diff_preview", "diffPreview"),
    gateStatus: coerceFromList(
      envelope.gate_status ?? envelope.gateStatus,
      PATCH_GATE_STATUSES,
      "pending",
    ),
    riskScore: readNumber(envelope, "risk_score", "riskScore"),
    warnings: readWarningMessages(
      envelope.warnings,
      isObject(checkResultsRaw) ? checkResultsRaw.warnings : undefined,
    ),
    checkResults,
    prUrl:
      readString(envelope, "pr_url", "prUrl")
      ?? readString(review, "pr_url", "prUrl"),
    createdAt: isoOrNull(envelope.created_at ?? envelope.createdAt),
    updatedAt: nonNullIso(
      envelope.updated_at ?? envelope.updatedAt,
      new Date().toISOString(),
    ),
  };
}
