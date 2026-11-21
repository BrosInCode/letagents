import { assertPlainWireValue, canonicalizeJson } from "#daemon-contract/index.js";
import type { EffectState } from "./schema.js";

export const MAX_EFFECT_ID_LENGTH = 256;
export const MAX_EFFECT_AGENT_ID_LENGTH = 256;
export const MAX_EFFECT_KIND_LENGTH = 128;
export const MAX_EFFECT_IDEMPOTENCY_KEY_LENGTH = 512;
export const MAX_EFFECT_PAYLOAD_BYTES = 256 * 1024;
export const MAX_EFFECT_OUTCOME_BYTES = 256 * 1024;
export const MAX_EFFECT_ERROR_BYTES = 16 * 1024;

export class EffectValidationError extends Error {
  override readonly name = "EffectValidationError";
}

export class EffectIdempotencyConflictError extends Error {
  override readonly name = "EffectIdempotencyConflictError";
}

export class EffectFenceError extends Error {
  override readonly name = "EffectFenceError";
}

export type EffectRecord = {
  id: string;
  agent_id: string;
  kind: string;
  idempotency_key: string;
  epoch: number;
  state: EffectState;
  payload: unknown;
  outcome: unknown;
  retryable: boolean;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at_ms: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type PrepareEffectInput = {
  id?: string;
  agent_id: string;
  kind: string;
  idempotency_key: string;
  epoch: number;
  payload: unknown;
  retryable?: boolean;
  max_attempts?: number;
  next_attempt_at_ms?: number | null;
};

export type PrepareEffectResult = {
  created: boolean;
  effect: EffectRecord;
};

export type EffectStartupRecoveryReport = {
  requeuedIds: string[];
  uncertainIds: string[];
  preparedIds: string[];
  allUncertainIds: string[];
};

export type EffectBackoffPolicy = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
};

export type EffectExecutionContext = {
  signal: AbortSignal;
  daemonGeneration: number;
  attemptCount: number;
  assertCurrent: () => Promise<void>;
};

export type EffectExecutionResult =
  | { status: "completed"; outcome?: unknown }
  /** Definite failure where the external mutation is known NOT to have taken effect. */
  | { status: "failed"; error: string; outcome?: unknown }
  /**
   * Transient failure on a `retryable: true` kind. Ignored (marked `uncertain`) if the
   * effect or handler is non-retryable, and settled as `failed` once `max_attempts` is exhausted.
   * Use `{ status: "uncertain" }` when external application cannot be ruled out.
   */
  | { status: "retry"; error: string; retryAfterMs?: number }
  | { status: "uncertain"; error: string; outcome?: unknown };

export type EffectReconcileResult =
  | { status: "completed"; outcome?: unknown }
  | { status: "failed"; error: string; outcome?: unknown }
  | { status: "still_uncertain"; error?: string };

export type EffectHandler = {
  /**
   * Per-kind retry policy: `true` ONLY when the external operation is idempotent
   * and safe to replay under the same `idempotency_key` after a crash or transient error.
   * Mutating at-most-once kinds MUST set `retryable: false`, ensuring interrupted
   * executions and unexpected throws settle to `uncertain` instead of replaying.
   */
  retryable: boolean;
  /** Default attempt cap when `retryable: true` (defaults to 3; must be 1 when `retryable: false`). */
  defaultMaxAttempts?: number;
  /** Execute the external side effect once the row is durably claimed as `executing`. */
  execute: (effect: EffectRecord, context: EffectExecutionContext) => Promise<EffectExecutionResult>;
  /**
   * Optional read-only verifier for `uncertain` rows (for example querying a remote
   * endpoint by `idempotency_key` after a crash between external commit and receipt
   * persistence). Must never replay a non-idempotent side effect.
   */
  reconcileUncertain?: (effect: EffectRecord, context: EffectExecutionContext) => Promise<EffectReconcileResult>;
  backoff?: EffectBackoffPolicy;
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function assertExactIdentifier(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || value.trim() !== value || CONTROL_CHARS.test(value)) {
    throw new EffectValidationError(`Effect ${label} must be a trimmed non-empty identifier of at most ${maxLength} characters.`);
  }
  return value;
}

export function assertPositiveEpoch(value: number, label = "epoch"): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EffectValidationError(`Effect ${label} must be a positive safe integer.`);
  }
  return value;
}

export function assertNonNegativeTimestampMs(value: number | null | undefined, label = "next_attempt_at_ms"): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EffectValidationError(`Effect ${label} must be a non-negative safe integer or null.`);
  }
  return value;
}

export function serializeEffectPayload(value: unknown, label = "payload"): string {
  try {
    assertPlainWireValue(value, label);
  } catch (error) {
    throw new EffectValidationError(error instanceof Error ? error.message : `Invalid effect ${label}.`);
  }
  const serialized = JSON.stringify(canonicalizeJson(value));
  if (typeof serialized !== "string") {
    throw new EffectValidationError(`Effect ${label} must serialize to a JSON value.`);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_EFFECT_PAYLOAD_BYTES) {
    throw new EffectValidationError(`Effect ${label} exceeds the ${MAX_EFFECT_PAYLOAD_BYTES}-byte durable limit.`);
  }
  return serialized;
}

export function serializeEffectOutcome(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    assertPlainWireValue(value, "outcome");
  } catch (error) {
    throw new EffectValidationError(error instanceof Error ? error.message : "Invalid effect outcome.");
  }
  const serialized = JSON.stringify(canonicalizeJson(value));
  if (typeof serialized !== "string") {
    throw new EffectValidationError("Effect outcome must serialize to a JSON value.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_EFFECT_OUTCOME_BYTES) {
    throw new EffectValidationError(`Effect outcome exceeds the ${MAX_EFFECT_OUTCOME_BYTES}-byte durable limit.`);
  }
  return serialized;
}

/**
 * Truncates diagnostic error text to a valid UTF-8 string within
 * `MAX_EFFECT_ERROR_BYTES` without splitting multi-byte code points.
 */
export function truncateEffectError(error: string): string {
  const normalized = error.trim() || "Unknown effect error.";
  if (Buffer.byteLength(normalized, "utf8") <= MAX_EFFECT_ERROR_BYTES) return normalized;
  const suffix = "… [truncated]";
  const prefixBytes = MAX_EFFECT_ERROR_BYTES - Buffer.byteLength(suffix, "utf8");
  const prefix = Buffer.from(normalized, "utf8").subarray(0, prefixBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  return `${prefix}${suffix}`;
}
