/**
 * Runtime-recovery outbound cloud HTTP sub-action descriptor (`endWorkerSession`),
 * idempotency key, allowlisted error classification, synchronous SQLite recovery-phase
 * authorization, and bounded terminal retention on the unified `effects` journal.
 *
 * Local OS-process death proof (`processBirthState`, `stopRef`, `stop`, `attach`),
 * durability terminal recording, and `agent_runtime_recoveries` archival remain owned
 * by `RuntimeRecoveryCoordinator` + `ManifestStore` because host birth/death proof
 * must never be substituted by a cached effect completion receipt.
 *
 * No supervisor host grants, grant IDs/generations, or arbitrary error text ever
 * enter `effects.payload`, `effects.outcome`, or `effects.last_error`.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { pruneTerminalEffectsByKindsInTransaction } from "./store.js";
import type { EffectBackoffPolicy } from "./types.js";

export const RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND = "runtime_recovery_end_worker_session" as const;
export const RUNTIME_RECOVERY_EFFECT_KINDS = [
  RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
] as const;

export const RUNTIME_RECOVERY_EFFECT_MAX_ATTEMPTS = 1_000_000;
export const RUNTIME_RECOVERY_RETAINED_TERMINAL_EFFECTS_PER_AGENT = 512;
export const RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS = 1_000;
export const RUNTIME_RECOVERY_EFFECT_MAX_RETRY_DELAY_MS = 15_000;
export const RUNTIME_RECOVERY_EFFECT_BACKOFF: EffectBackoffPolicy = {
  baseDelayMs: RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS,
  maxDelayMs: RUNTIME_RECOVERY_EFFECT_MAX_RETRY_DELAY_MS,
  factor: 2,
};

export type RuntimeRecoveryEndWorkerSessionEffectPayload = {
  operation_id: string | null;
  room_id: string;
  execution_generation_id: string | null;
  session_id: string;
  restarting: true;
};

export function runtimeRecoveryEndWorkerSessionIdempotencyKey(input: {
  operationId: string | null;
  roomId: string;
  executionGenerationId: string | null;
  sessionId: string;
}): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([
      input.operationId,
      input.roomId,
      input.executionGenerationId,
      input.sessionId,
    ]))
    .digest("hex");
  return `rrews:v1:${hash}`;
}

/**
 * Classifies a runtime-recovery outbound HTTP failure into a strictly allowlisted,
 * bounded error code suitable for durable storage in `effects.last_error`.
 * Arbitrary `Error.message`, `cause`, or server response fragments are never
 * persisted into the `effects` journal.
 */
export function classifyRuntimeRecoveryEffectError(error: unknown): string {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      return `http_${status}`;
    }
  }
  if (error instanceof SyntaxError) {
    return "invalid_json_response";
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "request_timeout";
    if (error.name === "AbortError") return "request_aborted";
  }
  return "transport_error";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parseRuntimeRecoveryEndWorkerSessionPayload(
  payload: unknown,
): RuntimeRecoveryEndWorkerSessionEffectPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (!isNullableString(raw.operation_id)
    || !isNonEmptyString(raw.room_id)
    || !isNullableString(raw.execution_generation_id)
    || !isNonEmptyString(raw.session_id)
    || raw.restarting !== true) {
    return null;
  }
  return {
    operation_id: raw.operation_id,
    room_id: raw.room_id,
    execution_generation_id: raw.execution_generation_id,
    session_id: raw.session_id,
    restarting: true,
  };
}

/**
 * Synchronously validates the durable `agent_runtime_recoveries` row inside a
 * claim or settlement transaction when an explicit `operation_id` is present
 * and the table exists in SQLite. Returns `null` when valid (or when running
 * `recoverAgentRuntimeExclusive` with `operationId: null`), or a bounded
 * allowlisted refusal code when the recovery record is missing, already
 * complete, or mismatched.
 */
export function checkRuntimeRecoveryPhaseInTransaction(
  database: DatabaseSync,
  input: {
    operationId: string | null;
    agentId: string;
    executionGenerationId: string | null;
  },
): string | null {
  if (input.operationId === null) return null;
  const hasTable = Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runtime_recoveries'").get(),
  );
  if (!hasTable) return null;
  const row = database.prepare(`
    SELECT agent_id, phase, execution_generation_id
    FROM agent_runtime_recoveries
    WHERE operation_id = ?
  `).get(input.operationId) as Record<string, unknown> | undefined;
  if (!row) return "recovery_missing";
  if (String(row.agent_id) !== input.agentId) return "recovery_agent_mismatch";
  if (String(row.phase) !== "stopped") return "recovery_phase_disallowed";
  if (input.executionGenerationId !== null && String(row.execution_generation_id) !== input.executionGenerationId) {
    return "recovery_runtime_mismatch";
  }
  return null;
}

export function pruneTerminalRuntimeRecoveryEffectsInTransaction(
  database: DatabaseSync,
  agentId: string,
  maxRetained = RUNTIME_RECOVERY_RETAINED_TERMINAL_EFFECTS_PER_AGENT,
): number {
  return pruneTerminalEffectsByKindsInTransaction(
    database,
    agentId,
    RUNTIME_RECOVERY_EFFECT_KINDS,
    maxRetained,
  );
}
