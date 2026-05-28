import type {
  DesktopRentalIdeKind,
  DesktopRentalQuotaSnapshot,
} from "../../ipc-types.js";

import { METER_CONFIDENCES, NATIVE_UNITS } from "./enums.js";
import {
  coerceFromList,
  isObject,
  isoOrNull,
  nonNullIso,
  readBool,
  readJsonObject,
  readNumber,
  readString,
} from "./primitives.js";

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
