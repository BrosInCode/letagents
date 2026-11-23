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
import { EFFECT_JOURNAL_TABLE } from "./schema.js";
import {
  failEffectInTransaction,
  listEffectsForAgent,
  pruneTerminalEffectsByKindsInTransaction,
} from "./store.js";
import {
  assertPositiveEpoch,
  EffectFenceError,
  type EffectBackoffPolicy,
  type EffectRecord,
} from "./types.js";

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

const PERMANENT_RUNTIME_RECOVERY_HTTP_STATUSES = new Set([400, 404, 405, 410, 422]);

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

/**
 * Returns true when an outbound `endWorkerSession` HTTP failure is a permanent
 * non-auth, non-fence 4xx rejection (`400`, `404`, `405`, `410`, `422`) that
 * must settle `failed` rather than retry or be treated as `completed`.
 *
 * The live server route (`POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/end`)
 * queries with `include_ended: true` and returns HTTP 200 when a session is
 * already ended (so `404` never proves retirement), and returns `401`/`403`/`409`
 * for expired or stale host-grant generations/fences that can recover once the
 * desktop installs a renewed grant under the same recovery operation.
 */
export function isPermanentRuntimeRecoveryEffectError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number"
    && Number.isInteger(status)
    && PERMANENT_RUNTIME_RECOVERY_HTTP_STATUSES.has(status);
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

export type RuntimeRecoveryPhaseCheck = {
  operationId: string | null;
  agentId: string;
  executionGenerationId: string | null;
  sessionId?: string;
};

function hasTable(database: DatabaseSync, tableName: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

/** Returns true when `agent_runtime_recoveries` exists and has a non-complete row for `agentId`. */
export function hasPendingRuntimeRecoveryForAgent(
  database: DatabaseSync,
  agentId: string,
): boolean {
  if (!hasTable(database, "agent_runtime_recoveries")) return false;
  return Boolean(
    database.prepare(`
      SELECT 1 FROM agent_runtime_recoveries
      WHERE agent_id = ? AND phase <> 'complete'
      LIMIT 1
    `).get(agentId),
  );
}

/**
 * Derives the exact durable recovery/owner phase check for one runtime-recovery
 * effect record, or returns `{ ok: false, error: "invalid_payload" }` when a
 * runtime-recovery effect carries a malformed payload. Returns `null` for
 * unrelated effect kinds.
 */
export function runtimeRecoveryEffectPhaseCheck(
  effect: Pick<EffectRecord, "agent_id" | "kind" | "payload">,
): { ok: true; phaseCheck: RuntimeRecoveryPhaseCheck } | { ok: false; error: "invalid_payload" } | null {
  if (effect.kind !== RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND) return null;
  const payload = parseRuntimeRecoveryEndWorkerSessionPayload(effect.payload);
  if (!payload) return { ok: false, error: "invalid_payload" };
  return {
    ok: true,
    phaseCheck: {
      operationId: payload.operation_id,
      agentId: effect.agent_id,
      executionGenerationId: payload.execution_generation_id,
      sessionId: payload.session_id,
    },
  };
}

/** Lists all active (`prepared` or `executing`) runtime-recovery effects for `agentId`. */
export function listActiveRuntimeRecoveryEffectsForAgent(
  database: DatabaseSync,
  agentId: string,
): EffectRecord[] {
  return listEffectsForAgent(database, agentId, {
    kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
    states: ["prepared", "executing"],
  });
}

function lastWorkerBindingSessionId(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as { agent_session_id?: unknown } | null;
    return parsed && typeof parsed === "object" && typeof parsed.agent_session_id === "string"
      ? parsed.agent_session_id
      : null;
  } catch {
    return null;
  }
}

/**
 * Synchronously validates the durable recovery owner inside a claim,
 * settlement, or startup-reconciliation transaction when the corresponding
 * SQLite tables exist:
 * - When `operationId !== null` (`repairRuntime`), validates the exact
 *   `agent_runtime_recoveries` row (`phase === "stopped"`, matching `agent_id`
 *   and `execution_generation_id`).
 * - When `operationId === null` (`recoverAgentRuntimeExclusive`), validates
 *   that `agents` still holds a non-stopped agent with no pending
 *   `agent_runtime_recoveries` row and (when `worker_session_bindings` exists
 *   and `sessionId` is supplied) still references that `sessionId` via either
 *   `worker_session_bindings` or `agents.last_worker_binding_json`.
 *
 * Returns `null` when valid (or when running in a minimal unit harness without
 * the corresponding tables), or a bounded allowlisted refusal code otherwise.
 */
export function checkRuntimeRecoveryPhaseInTransaction(
  database: DatabaseSync,
  input: RuntimeRecoveryPhaseCheck,
): string | null {
  if (input.operationId !== null) {
    if (!hasTable(database, "agent_runtime_recoveries")) return null;
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

  if (!hasTable(database, "agents")) return null;
  const agentRow = database.prepare(`
    SELECT desired_state, last_worker_binding_json
    FROM agents
    WHERE agent_id = ?
  `).get(input.agentId) as { desired_state?: unknown; last_worker_binding_json?: unknown } | undefined;
  if (!agentRow) return "agent_missing";
  if (String(agentRow.desired_state) === "stopped") return "agent_stopped";
  if (hasPendingRuntimeRecoveryForAgent(database, input.agentId)) return "recovery_pending";
  if (input.sessionId !== undefined && hasTable(database, "worker_session_bindings")) {
    const hasLiveBinding = Boolean(
      database.prepare(`
        SELECT 1 FROM worker_session_bindings
        WHERE entry_id = ? AND agent_session_id = ?
        LIMIT 1
      `).get(input.agentId, input.sessionId),
    );
    const matchesRetained = lastWorkerBindingSessionId(agentRow.last_worker_binding_json) === input.sessionId;
    if (!hasLiveBinding && !matchesRetained) return "worker_session_absent";
  }
  return null;
}

/**
 * Atomically retires `prepared` runtime-recovery HTTP effects for
 * `(agentId, operationId)` inside an active fenced SQLite transaction (for
 * example when `completeRuntimeRecovery` marks `phase = 'complete'`). Live
 * `executing` rows are never touched; their own transactional settlement
 * fences against `agent_runtime_recoveries` instead.
 */
export function retireRuntimeRecoveryEffectsForOperationInTransaction(
  database: DatabaseSync,
  input: {
    agentId: string;
    operationId: string;
    expectedEpoch?: number;
    error: string;
    nowIso?: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError(
      "retireRuntimeRecoveryEffectsForOperationInTransaction requires an active fenced SQLite transaction.",
    );
  }
  const explicitEpoch = input.expectedEpoch !== undefined
    ? assertPositiveEpoch(input.expectedEpoch, "expectedEpoch")
    : undefined;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const preparedRows = database.prepare(`
    SELECT id, epoch FROM ${EFFECT_JOURNAL_TABLE}
    WHERE agent_id = ?
      AND kind = ?
      AND state = 'prepared'
      AND json_extract(payload, '$.operation_id') = ?
    ORDER BY created_at ASC, id ASC
  `).all(
    input.agentId,
    RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
    input.operationId,
  ) as Array<{ id: string; epoch: number }>;
  for (const row of preparedRows) {
    failEffectInTransaction(database, {
      id: String(row.id),
      expectedEpoch: explicitEpoch ?? Math.max(1, Number(row.epoch)),
      error: input.error,
      nowIso,
    });
  }
  if (preparedRows.length > 0) {
    pruneTerminalRuntimeRecoveryEffectsInTransaction(database, input.agentId);
  }
  return preparedRows.length;
}

/**
 * Retires any `prepared` runtime-recovery HTTP effect whose durable owner
 * (`agent_runtime_recoveries` when `operation_id !== null`, or `agents` +
 * worker binding when `operation_id === null`) is missing, terminal, stopped,
 * or no longer references the session (for example after crash recovery
 * requeues an interrupted `executing` effect to `prepared`, after a binding
 * was removed by another path, or after a downgrade/reupgrade where an older
 * daemon completed recovery without touching `effects`). Live `executing`
 * rows are never touched.
 */
export function retireStaleRuntimeRecoveryEffectsInTransaction(
  database: DatabaseSync,
  input: {
    agentId?: string;
    expectedEpoch: number;
    nowIso?: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError(
      "retireStaleRuntimeRecoveryEffectsInTransaction requires an active fenced SQLite transaction.",
    );
  }
  const epoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const nowIso = input.nowIso ?? new Date().toISOString();
  const rows = (input.agentId !== undefined
    ? database.prepare(`
        SELECT id, agent_id, kind, payload FROM ${EFFECT_JOURNAL_TABLE}
        WHERE agent_id = ?
          AND kind = ?
          AND state = 'prepared'
        ORDER BY created_at ASC, id ASC
      `).all(input.agentId, RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND)
    : database.prepare(`
        SELECT id, agent_id, kind, payload FROM ${EFFECT_JOURNAL_TABLE}
        WHERE kind = ?
          AND state = 'prepared'
        ORDER BY created_at ASC, id ASC
      `).all(RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND)) as Array<{
    id: string;
    agent_id: string;
    kind: string;
    payload: string;
  }>;
  const touchedAgents = new Set<string>();
  let retired = 0;
  for (const row of rows) {
    let parsedPayload: unknown = null;
    try {
      parsedPayload = JSON.parse(String(row.payload));
    } catch {
      parsedPayload = null;
    }
    const check = runtimeRecoveryEffectPhaseCheck({
      agent_id: String(row.agent_id),
      kind: String(row.kind),
      payload: parsedPayload,
    });
    if (!check) continue;
    const refusal = check.ok
      ? checkRuntimeRecoveryPhaseInTransaction(database, check.phaseCheck)
      : check.error;
    if (refusal === null) continue;
    failEffectInTransaction(database, {
      id: String(row.id),
      expectedEpoch: epoch,
      error: refusal,
      nowIso,
    });
    touchedAgents.add(String(row.agent_id));
    retired += 1;
  }
  for (const agentId of touchedAgents) {
    pruneTerminalRuntimeRecoveryEffectsInTransaction(database, agentId);
  }
  return retired;
}

/**
 * Retires leftover `prepared` runtime-recovery HTTP effects for a fully
 * stopped agent with no pending `agent_runtime_recoveries` row inside
 * `preparePurge`/`commitPurge`, before `assertPurgePreconditions` runs.
 * Any pending runtime recovery, live `executing` effect, non-stopped agent
 * lifecycle, or future-epoch row fails closed and rolls back atomically.
 */
export function retireRuntimeRecoveryEffectsForPurgeInTransaction(
  database: DatabaseSync,
  input: {
    agentId: string;
    expectedEpoch: number;
    nowIso?: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError(
      "retireRuntimeRecoveryEffectsForPurgeInTransaction requires an active fenced SQLite transaction.",
    );
  }
  const epoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const lifecycle = database.prepare("SELECT desired_state, observed_state FROM agents WHERE agent_id = ?")
    .get(input.agentId) as { desired_state?: string; observed_state?: string } | undefined;
  if (!lifecycle
    || lifecycle.desired_state !== "stopped"
    || !["absent", "stopped", "failed"].includes(String(lifecycle.observed_state))) {
    return 0;
  }
  if (hasPendingRuntimeRecoveryForAgent(database, input.agentId)) {
    return 0;
  }
  const nowIso = input.nowIso ?? new Date().toISOString();
  const preparedRows = database.prepare(`
    SELECT id FROM ${EFFECT_JOURNAL_TABLE}
    WHERE agent_id = ?
      AND kind = ?
      AND state = 'prepared'
    ORDER BY created_at ASC, id ASC
  `).all(input.agentId, RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND) as Array<{ id: string }>;
  for (const row of preparedRows) {
    failEffectInTransaction(database, {
      id: String(row.id),
      expectedEpoch: epoch,
      error: "agent_purged",
      nowIso,
    });
  }
  if (preparedRows.length > 0) {
    pruneTerminalRuntimeRecoveryEffectsInTransaction(database, input.agentId);
  }
  return preparedRows.length;
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
