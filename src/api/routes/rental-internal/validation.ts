import { INGEST_CONFIDENCE_VALUES, type IngestUsageReport } from "../../rental/usage-ingest.js";
import type { BudgetReconcileInput, BudgetReserveInput } from "../../rental/budget-orchestrator.js";

export function isRentEnabled(): boolean {
  const v = process.env.LETAGENTS_RENT_ENABLED ?? "";
  return /^(1|true|yes)$/i.test(v.trim());
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isFinite(value);
}

export function parseReport(body: unknown): IngestUsageReport | { error: string } {
  if (!isPlainObject(body)) return { error: "body must be an object" };
  const b = body;

  // source enum
  if (typeof b.source !== "string"
      || !["adapter", "tool", "self_reported", "system"].includes(b.source)) {
    return { error: "source must be one of adapter|tool|self_reported|system" };
  }

  // snapshot — nested shape must be valid before reaching the service.
  if (!isPlainObject(b.snapshot)) return { error: "snapshot is required" };
  const snap = b.snapshot;
  if (typeof snap.provider !== "string" || !snap.provider.trim()) {
    return { error: "snapshot.provider must be a non-empty string" };
  }
  if (snap.model !== undefined && snap.model !== null && typeof snap.model !== "string") {
    return { error: "snapshot.model must be string|null|undefined" };
  }
  if (snap.nativeUnit !== undefined && snap.nativeUnit !== null && typeof snap.nativeUnit !== "string") {
    return { error: "snapshot.nativeUnit must be string|null|undefined" };
  }
  if (!isOptionalFiniteNumber(snap.nativeUsed)
      || !isOptionalFiniteNumber(snap.nativeRemaining)) {
    return { error: "snapshot.nativeUsed / nativeRemaining must be finite numbers or null" };
  }
  if (snap.nativeResetAt !== undefined && snap.nativeResetAt !== null
      && (typeof snap.nativeResetAt !== "string" || Number.isNaN(Date.parse(snap.nativeResetAt)))) {
    return { error: "snapshot.nativeResetAt must be an ISO timestamp or null" };
  }

  // lrt — nested shape must be valid.
  if (!isPlainObject(b.lrt)) return { error: "lrt is required" };
  const lrt = b.lrt;
  if (typeof lrt.lrtUsed !== "number" || !Number.isFinite(lrt.lrtUsed)) {
    return { error: "lrt.lrtUsed must be a finite number" };
  }
  if (typeof lrt.confidence !== "string"
      || !(INGEST_CONFIDENCE_VALUES as readonly string[]).includes(lrt.confidence)) {
    return {
      error: `lrt.confidence must be one of ${INGEST_CONFIDENCE_VALUES.join("|")}`,
    };
  }

  // delta — optional but must be an object when present, every numeric
  // field finite and non-negative when present. Reject silently-bad input
  // (e.g. "12.4" string) rather than coercing it to 0.
  if (b.delta !== undefined) {
    if (!isPlainObject(b.delta)) {
      return { error: "delta must be an object when provided" };
    }
    const deltaIntFields = [
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "reasoningTokens",
      "requests",
      "toolCalls",
      "commandRuns",
      "filesExposed",
      "heartbeats",
    ] as const;
    for (const f of deltaIntFields) {
      const v = (b.delta as Record<string, unknown>)[f];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { error: `delta.${f} must be a finite number when provided` };
      }
    }
    const deltaNumericFields = ["credits", "usd"] as const;
    for (const f of deltaNumericFields) {
      const v = (b.delta as Record<string, unknown>)[f];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { error: `delta.${f} must be a finite number or null when provided` };
      }
    }
  }

  // idempotencyKey
  if (typeof b.idempotencyKey !== "string" || !b.idempotencyKey.trim()) {
    return { error: "idempotencyKey is required" };
  }

  // adapterPayload optional
  if (b.adapterPayload !== undefined
      && b.adapterPayload !== null
      && !isPlainObject(b.adapterPayload)) {
    return { error: "adapterPayload must be an object or null" };
  }

  // lastHeartbeatAt optional
  if (b.lastHeartbeatAt !== undefined
      && b.lastHeartbeatAt !== null
      && (typeof b.lastHeartbeatAt !== "string" || Number.isNaN(Date.parse(b.lastHeartbeatAt)))) {
    return { error: "lastHeartbeatAt must be an ISO timestamp or null" };
  }

  return b as unknown as IngestUsageReport;
}

function finiteNonNegativeField(
  body: Record<string, unknown>,
  field: string,
): number | { error: string } {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { error: `${field} must be a finite non-negative number` };
  }
  return value;
}

export function parseReserve(body: unknown): BudgetReserveInput | { error: string } {
  if (!isPlainObject(body)) return { error: "body must be an object" };
  const stepCostLrt = finiteNonNegativeField(body, "stepCostLrt");
  if (typeof stepCostLrt !== "number") return stepCostLrt;
  return { stepCostLrt };
}

export function parseReconcile(body: unknown): BudgetReconcileInput | { error: string } {
  if (!isPlainObject(body)) return { error: "body must be an object" };
  const actualCostLrt = finiteNonNegativeField(body, "actualCostLrt");
  if (typeof actualCostLrt !== "number") return actualCostLrt;
  const reservedCostLrt = finiteNonNegativeField(body, "reservedCostLrt");
  if (typeof reservedCostLrt !== "number") return reservedCostLrt;
  return { actualCostLrt, reservedCostLrt };
}

export function optionalPositiveInteger(
  body: Record<string, unknown>,
  field: string,
  max: number,
): number | undefined | { error: string } {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value <= 0
  ) {
    return { error: `${field} must be a positive integer` };
  }
  return Math.min(value, max);
}

export function contextErrorStatus(error: string | undefined): number {
  if (!error) return 500;
  if (
    error.includes("required")
    || error.includes("absolute_path")
    || error.includes("traversal")
    || error.includes("null byte")
  ) {
    return 400;
  }
  if (error === "file_not_found") return 404;
  if (error === "not_a_file") return 400;
  if (error.startsWith("file_too_large")) return 413;
  if (error === "secret_blocked" || error === "symlink_rejected") return 403;
  if (error.startsWith("workspace_")) return 409;
  return 500;
}

export function normalizeIdempotencyKey(body: Record<string, unknown>): string | { error: string } {
  const key = body.idempotencyKey ?? body.idempotency_key;
  if (typeof key !== "string" || !key.trim()) {
    return { error: "idempotencyKey is required" };
  }
  return key.trim();
}

export function normalizePatchFiles(value: unknown): unknown[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "files must be a non-empty array" };
  }
  return value;
}
