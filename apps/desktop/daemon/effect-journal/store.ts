/**
 * Plain synchronous SQLite functions for the unified external-effect journal.
 *
 * Uses the daemon's single shared `DatabaseSync` handle. Every standalone write
 * runs inside `BEGIN IMMEDIATE` with `assertWriteFence()` invoked before any
 * mutation or `COMMIT`. Callers that need to commit internal domain state and
 * new outbound effects atomically call `prepareEffectInTransaction` inside
 * their own fenced write transaction.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BOUNDED_MCP_EFFECT_KIND,
  boundedMcpEffectTurnHasActiveAuthority,
  rowToBoundedMcpEffect,
} from "./bounded-mcp.js";
import { ASYNC_RPC_EFFECT_KINDS } from "./rpc-effects.js";
import { EFFECT_JOURNAL_TABLE, type EffectState } from "./schema.js";
import {
  EffectClaimRefusedError,
  EffectFenceError,
  EffectIdempotencyConflictError,
  EffectValidationError,
  MAX_EFFECT_AGENT_ID_LENGTH,
  MAX_EFFECT_IDEMPOTENCY_KEY_LENGTH,
  MAX_EFFECT_ID_LENGTH,
  MAX_EFFECT_KIND_LENGTH,
  assertExactIdentifier,
  assertNonNegativeTimestampMs,
  assertPositiveEpoch,
  serializeEffectOutcome,
  serializeEffectPayload,
  truncateEffectError,
  type EffectRecord,
  type EffectStartupRecoveryReport,
  type PrepareEffectInput,
  type PrepareEffectResult,
} from "./types.js";

type Row = Record<string, unknown>;

const TABLE = EFFECT_JOURNAL_TABLE;

function rowToEffectRecord(row: Row): EffectRecord {
  return {
    id: String(row.id),
    agent_id: String(row.agent_id),
    kind: String(row.kind),
    idempotency_key: String(row.idempotency_key),
    epoch: Number(row.epoch),
    state: String(row.state) as EffectState,
    payload: JSON.parse(String(row.payload)),
    outcome: row.outcome === null || row.outcome === undefined ? null : JSON.parse(String(row.outcome)),
    retryable: Number(row.retryable) === 1,
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    next_attempt_at_ms: row.next_attempt_at_ms === null || row.next_attempt_at_ms === undefined
      ? null
      : Number(row.next_attempt_at_ms),
    last_error: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** Runs a synchronous write transaction gated by the daemon's generation write fence. */
export function withFencedEffectTransaction<T>(
  database: DatabaseSync,
  assertWriteFence: () => void,
  body: () => T,
): T {
  if (database.isTransaction) {
    throw new EffectFenceError("Effect journal write cannot nest inside an active SQLite transaction; use the *InTransaction helper instead.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    assertWriteFence();
    const result = body();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* already closed */ }
    throw error;
  }
}

/**
 * Prepares (or idempotently returns) an outbound effect inside an already-open
 * fenced write transaction. Use this when committing domain state changes and
 * their outbound effects atomically.
 */
export function prepareEffectInTransaction(
  database: DatabaseSync,
  input: PrepareEffectInput,
  nowIso: string = new Date().toISOString(),
): PrepareEffectResult {
  if (!database.isTransaction) {
    throw new EffectFenceError("prepareEffectInTransaction requires an active fenced SQLite transaction.");
  }
  const agentId = assertExactIdentifier(input.agent_id, "agent_id", MAX_EFFECT_AGENT_ID_LENGTH);
  const kind = assertExactIdentifier(input.kind, "kind", MAX_EFFECT_KIND_LENGTH);
  const idempotencyKey = assertExactIdentifier(input.idempotency_key, "idempotency_key", MAX_EFFECT_IDEMPOTENCY_KEY_LENGTH);
  const epoch = assertPositiveEpoch(input.epoch);
  const retryable = Boolean(input.retryable ?? false);
  const maxAttempts = input.max_attempts ?? (retryable ? 3 : 1);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new EffectValidationError("Effect max_attempts must be a positive safe integer.");
  }
  if (!retryable && maxAttempts !== 1) {
    throw new EffectValidationError("Non-retryable effects must have max_attempts = 1.");
  }
  const nextAttemptAtMs = assertNonNegativeTimestampMs(input.next_attempt_at_ms);
  const payloadJson = serializeEffectPayload(input.payload);
  const requestedId = input.id !== undefined
    ? assertExactIdentifier(input.id, "id", MAX_EFFECT_ID_LENGTH)
    : undefined;

  const existing = database.prepare(`
    SELECT * FROM ${TABLE}
    WHERE agent_id = ? AND kind = ? AND idempotency_key = ?
  `).get(agentId, kind, idempotencyKey) as Row | undefined;
  if (existing) {
    if (Number(existing.epoch) > epoch) {
      throw new EffectFenceError(
        `Stale daemon generation ${epoch} cannot prepare effect ${String(existing.id)} owned by epoch ${Number(existing.epoch)}.`,
      );
    }
    if (requestedId !== undefined && String(existing.id) !== requestedId) {
      throw new EffectIdempotencyConflictError("Effect idempotency key is already bound to a different effect id.");
    }
    if (String(existing.payload) !== payloadJson
      || (Number(existing.retryable) === 1) !== retryable
      || Number(existing.max_attempts) !== maxAttempts) {
      throw new EffectIdempotencyConflictError(
        `Effect idempotency key ${kind}:${idempotencyKey} was reused with a different payload or retry policy.`,
      );
    }
    return { created: false, effect: rowToEffectRecord(existing) };
  }

  const effectId = requestedId ?? randomUUID();
  if (requestedId !== undefined) {
    const idCollision = database.prepare(`SELECT 1 FROM ${TABLE} WHERE id = ?`).get(effectId);
    if (idCollision) {
      throw new EffectIdempotencyConflictError(`Effect id ${effectId} is already bound to a different idempotency key.`);
    }
  }

  database.prepare(`
    INSERT INTO ${TABLE} (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, NULL, ?, 0, ?, ?, NULL, ?, ?)
  `).run(
    effectId,
    agentId,
    kind,
    idempotencyKey,
    epoch,
    payloadJson,
    retryable ? 1 : 0,
    maxAttempts,
    nextAttemptAtMs,
    nowIso,
    nowIso,
  );
  const inserted = database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(effectId) as Row;
  return { created: true, effect: rowToEffectRecord(inserted) };
}

/** Standalone fenced prepare for callers without an outer domain transaction. */
export function prepareEffect(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: PrepareEffectInput,
  nowIso: string = new Date().toISOString(),
): PrepareEffectResult {
  return withFencedEffectTransaction(database, assertWriteFence, () =>
    prepareEffectInTransaction(database, input, nowIso),
  );
}

export function getEffect(database: DatabaseSync, id: string): EffectRecord | null {
  const row = database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) as Row | undefined;
  return row ? rowToEffectRecord(row) : null;
}

export function getEffectByIdempotencyKey(
  database: DatabaseSync,
  agentId: string,
  kind: string,
  idempotencyKey: string,
): EffectRecord | null {
  const row = database.prepare(`
    SELECT * FROM ${TABLE}
    WHERE agent_id = ? AND kind = ? AND idempotency_key = ?
  `).get(agentId, kind, idempotencyKey) as Row | undefined;
  return row ? rowToEffectRecord(row) : null;
}

export function listEffectsForAgent(
  database: DatabaseSync,
  agentId: string,
  options: { kind?: string; states?: readonly EffectState[]; limit?: number } = {},
): EffectRecord[] {
  const clauses = ["agent_id = ?"];
  const args: unknown[] = [agentId];
  if (options.kind !== undefined) {
    clauses.push("kind = ?");
    args.push(options.kind);
  }
  if (options.states && options.states.length > 0) {
    clauses.push(`state IN (${options.states.map(() => "?").join(", ")})`);
    args.push(...options.states);
  }
  const limitClause = options.limit !== undefined ? " LIMIT ?" : "";
  if (options.limit !== undefined) args.push(options.limit);
  const rows = database.prepare(`
    SELECT * FROM ${TABLE}
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at, id${limitClause}
  `).all(...args as never[]) as Row[];
  return rows.map(rowToEffectRecord);
}

export function listDuePreparedEffects(
  database: DatabaseSync,
  nowMs: number,
  kinds?: readonly string[],
  limit = 64,
  options: { excludeIds?: readonly string[]; maxEpoch?: number } = {},
): EffectRecord[] {
  if (kinds && kinds.length === 0) return [];
  const clauses = [
    "state = 'prepared'",
    "(next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)",
    "attempt_count < max_attempts",
  ];
  const args: unknown[] = [nowMs];
  if (kinds) {
    clauses.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    args.push(...kinds);
  }
  if (options.excludeIds && options.excludeIds.length > 0) {
    clauses.push(`id NOT IN (${options.excludeIds.map(() => "?").join(", ")})`);
    args.push(...options.excludeIds);
  }
  if (options.maxEpoch !== undefined) {
    clauses.push("epoch <= ?");
    args.push(options.maxEpoch);
  }
  args.push(limit);
  const rows = database.prepare(`
    SELECT * FROM ${TABLE}
    WHERE ${clauses.join(" AND ")}
    ORDER BY COALESCE(next_attempt_at_ms, 0), created_at, id
    LIMIT ?
  `).all(...args as never[]) as Row[];
  return rows.map(rowToEffectRecord);
}

export function nextScheduledPreparedEffectAtMs(
  database: DatabaseSync,
  kinds?: readonly string[],
  options: { excludeIds?: readonly string[]; maxEpoch?: number } = {},
): number | null {
  if (kinds && kinds.length === 0) return null;
  const clauses = [
    "state = 'prepared'",
    "attempt_count < max_attempts",
  ];
  const args: unknown[] = [];
  if (kinds) {
    clauses.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    args.push(...kinds);
  }
  if (options.excludeIds && options.excludeIds.length > 0) {
    clauses.push(`id NOT IN (${options.excludeIds.map(() => "?").join(", ")})`);
    args.push(...options.excludeIds);
  }
  if (options.maxEpoch !== undefined) {
    clauses.push("epoch <= ?");
    args.push(options.maxEpoch);
  }
  const row = database.prepare(`
    SELECT MIN(COALESCE(next_attempt_at_ms, 0)) AS due_ms
    FROM ${TABLE}
    WHERE ${clauses.join(" AND ")}
  `).get(...args as never[]) as Row | undefined;
  return row && row.due_ms !== null && row.due_ms !== undefined ? Number(row.due_ms) : null;
}

export function listUncertainEffects(
  database: DatabaseSync,
  kinds?: readonly string[],
  limit = 64,
): EffectRecord[] {
  if (kinds && kinds.length === 0) return [];
  const kindClause = kinds ? ` AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
  const rows = database.prepare(`
    SELECT * FROM ${TABLE}
    WHERE state = 'uncertain'${kindClause}
    ORDER BY created_at, id
    LIMIT ?
  `).all(...[...(kinds ?? []), limit] as never[]) as Row[];
  return rows.map(rowToEffectRecord);
}

/**
 * Atomically claims a `prepared` effect for execution under `daemonGeneration`.
 * Advances `epoch` monotonically and increments `attempt_count` so any late
 * settlement from an earlier generation or attempt is rejected by CAS.
 */
export function claimEffectForExecution(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    id: string;
    daemonGeneration: number;
    expectedEpoch?: number;
    nowMs: number;
    nowIso?: string;
    authorizeClaim?: (database: DatabaseSync, effect: EffectRecord) => string | null;
  },
): EffectRecord {
  const daemonGeneration = assertPositiveEpoch(input.daemonGeneration, "daemonGeneration");
  if (input.expectedEpoch !== undefined) assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const nowIso = input.nowIso ?? new Date(input.nowMs).toISOString();
  const outcome = withFencedEffectTransaction(database, assertWriteFence, (): { claimed: EffectRecord | null; refusal: string | null } => {
    const row = database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row | undefined;
    if (!row) throw new EffectFenceError(`Unknown effect ${input.id}.`);
    const current = rowToEffectRecord(row);
    if (current.state !== "prepared") {
      throw new EffectFenceError(`Effect ${input.id} cannot be claimed from state ${current.state}.`);
    }
    if (current.epoch > daemonGeneration) {
      throw new EffectFenceError(
        `Stale daemon generation ${daemonGeneration} cannot claim effect ${input.id} owned by epoch ${current.epoch}.`,
      );
    }
    if (input.expectedEpoch !== undefined && current.epoch !== input.expectedEpoch) {
      throw new EffectFenceError(
        `Effect ${input.id} epoch mismatch: expected ${input.expectedEpoch}, found ${current.epoch}.`,
      );
    }
    if (current.attempt_count >= current.max_attempts) {
      throw new EffectFenceError(`Effect ${input.id} has exhausted its ${current.max_attempts} attempt(s).`);
    }
    if (current.next_attempt_at_ms !== null && current.next_attempt_at_ms > input.nowMs) {
      throw new EffectFenceError(`Effect ${input.id} is backed off until ${current.next_attempt_at_ms}.`);
    }
    if (input.authorizeClaim) {
      const refusal = input.authorizeClaim(database, current);
      if (refusal !== null) {
        const errorText = truncateEffectError(refusal);
        const failed = database.prepare(`
          UPDATE ${TABLE}
          SET state = 'failed',
              epoch = ?,
              outcome = NULL,
              last_error = ?,
              next_attempt_at_ms = NULL,
              updated_at = ?
          WHERE id = ? AND state = 'prepared' AND epoch = ? AND attempt_count = ?
        `).run(daemonGeneration, errorText, nowIso, input.id, current.epoch, current.attempt_count);
        if (Number(failed.changes) !== 1) {
          throw new EffectFenceError(`Effect ${input.id} lost its claim refusal compare-and-swap fence.`);
        }
        return { claimed: null, refusal: errorText };
      }
    }
    const result = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'executing',
          epoch = ?,
          attempt_count = attempt_count + 1,
          next_attempt_at_ms = NULL,
          updated_at = ?
      WHERE id = ? AND state = 'prepared' AND epoch = ? AND attempt_count = ?
    `).run(daemonGeneration, nowIso, input.id, current.epoch, current.attempt_count);
    if (Number(result.changes) !== 1) {
      throw new EffectFenceError(`Effect ${input.id} lost its claim compare-and-swap fence.`);
    }
    return {
      claimed: rowToEffectRecord(database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row),
      refusal: null,
    };
  });
  if (outcome.refusal !== null) {
    throw new EffectClaimRefusedError(outcome.refusal);
  }
  return outcome.claimed!;
}

/** Settles an `executing` effect as `completed` under its exact `(epoch, attempt_count)` lease. */
export function completeEffect(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    id: string;
    expectedEpoch: number;
    expectedAttemptCount: number;
    outcome?: unknown;
    nowIso?: string;
  },
): EffectRecord {
  const expectedEpoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const expectedAttemptCount = assertPositiveEpoch(input.expectedAttemptCount, "expectedAttemptCount");
  const outcomeJson = serializeEffectOutcome(input.outcome);
  const nowIso = input.nowIso ?? new Date().toISOString();
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    const result = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'completed',
          outcome = ?,
          last_error = NULL,
          next_attempt_at_ms = NULL,
          updated_at = ?
      WHERE id = ? AND state = 'executing' AND epoch = ? AND attempt_count = ?
    `).run(outcomeJson, nowIso, input.id, expectedEpoch, expectedAttemptCount);
    if (Number(result.changes) !== 1) {
      throw describeSettleFenceError(database, input.id, "completed", expectedEpoch, expectedAttemptCount);
    }
    return rowToEffectRecord(database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row);
  });
}

/**
 * Settles an `executing` effect as `failed` under its exact `(epoch, attempt_count)` lease,
 * or cancels a `prepared` effect before dispatch when `expectedAttemptCount` is omitted.
 */
export function failEffect(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    id: string;
    expectedEpoch: number;
    expectedAttemptCount?: number;
    error: string;
    outcome?: unknown;
    nowIso?: string;
  },
): EffectRecord {
  const expectedEpoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const errorText = truncateEffectError(input.error);
  const outcomeJson = serializeEffectOutcome(input.outcome);
  const nowIso = input.nowIso ?? new Date().toISOString();
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    if (input.expectedAttemptCount !== undefined) {
      const attemptCount = assertPositiveEpoch(input.expectedAttemptCount, "expectedAttemptCount");
      const result = database.prepare(`
        UPDATE ${TABLE}
        SET state = 'failed',
            outcome = ?,
            last_error = ?,
            next_attempt_at_ms = NULL,
            updated_at = ?
        WHERE id = ? AND state = 'executing' AND epoch = ? AND attempt_count = ?
      `).run(outcomeJson, errorText, nowIso, input.id, expectedEpoch, attemptCount);
      if (Number(result.changes) !== 1) {
        throw describeSettleFenceError(database, input.id, "failed", expectedEpoch, attemptCount);
      }
      return rowToEffectRecord(database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row);
    }

    const row = database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row | undefined;
    if (!row) throw new EffectFenceError(`Unknown effect ${input.id}.`);
    const current = rowToEffectRecord(row);
    if (current.state !== "prepared") {
      throw new EffectFenceError(`Effect ${input.id} cannot be cancelled from state ${current.state}.`);
    }
    if (current.epoch > expectedEpoch) {
      throw new EffectFenceError(
        `Stale daemon generation ${expectedEpoch} cannot fail effect ${input.id} owned by epoch ${current.epoch}.`,
      );
    }
    const result = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'failed',
          epoch = ?,
          outcome = ?,
          last_error = ?,
          next_attempt_at_ms = NULL,
          updated_at = ?
      WHERE id = ? AND state = 'prepared' AND epoch = ?
    `).run(expectedEpoch, outcomeJson, errorText, nowIso, input.id, current.epoch);
    if (Number(result.changes) !== 1) {
      throw new EffectFenceError(`Effect ${input.id} lost its pre-dispatch fail fence.`);
    }
    return rowToEffectRecord(database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row);
  });
}

/** Transitions an `executing` effect back to `prepared` with a retry backoff deadline. */
export function rescheduleEffectForRetry(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    id: string;
    expectedEpoch: number;
    expectedAttemptCount: number;
    nextAttemptAtMs: number;
    error: string;
    nowIso?: string;
  },
): EffectRecord {
  const expectedEpoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const expectedAttemptCount = assertPositiveEpoch(input.expectedAttemptCount, "expectedAttemptCount");
  const nextAttemptAtMs = assertNonNegativeTimestampMs(input.nextAttemptAtMs);
  if (nextAttemptAtMs === null) {
    throw new EffectValidationError("Rescheduled retry requires a non-negative nextAttemptAtMs.");
  }
  const errorText = truncateEffectError(input.error);
  const nowIso = input.nowIso ?? new Date().toISOString();
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    const row = database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row | undefined;
    if (!row) throw new EffectFenceError(`Unknown effect ${input.id}.`);
    const current = rowToEffectRecord(row);
    if (current.state !== "executing" || current.epoch !== expectedEpoch || current.attempt_count !== expectedAttemptCount) {
      throw describeSettleFenceError(database, input.id, "prepared", expectedEpoch, expectedAttemptCount);
    }
    if (!current.retryable) {
      throw new EffectFenceError(`Non-retryable effect ${input.id} cannot be rescheduled for retry.`);
    }
    if (current.attempt_count >= current.max_attempts) {
      throw new EffectFenceError(`Effect ${input.id} cannot retry past max_attempts (${current.max_attempts}).`);
    }
    const result = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'prepared',
          outcome = NULL,
          next_attempt_at_ms = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND state = 'executing' AND retryable = 1 AND epoch = ? AND attempt_count = ?
    `).run(nextAttemptAtMs, errorText, nowIso, input.id, expectedEpoch, expectedAttemptCount);
    if (Number(result.changes) !== 1) {
      throw describeSettleFenceError(database, input.id, "prepared", expectedEpoch, expectedAttemptCount);
    }
    return rowToEffectRecord(database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row);
  });
}

/** Transitions an `executing` effect to `uncertain` when its external outcome cannot be proven. */
export function markEffectUncertain(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    id: string;
    expectedEpoch: number;
    expectedAttemptCount: number;
    error: string;
    outcome?: unknown;
    nowIso?: string;
  },
): EffectRecord {
  const expectedEpoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const expectedAttemptCount = assertPositiveEpoch(input.expectedAttemptCount, "expectedAttemptCount");
  const errorText = truncateEffectError(input.error);
  const outcomeJson = serializeEffectOutcome(input.outcome);
  const nowIso = input.nowIso ?? new Date().toISOString();
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    const result = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'uncertain',
          outcome = ?,
          last_error = ?,
          next_attempt_at_ms = NULL,
          updated_at = ?
      WHERE id = ? AND state = 'executing' AND epoch = ? AND attempt_count = ?
    `).run(outcomeJson, errorText, nowIso, input.id, expectedEpoch, expectedAttemptCount);
    if (Number(result.changes) !== 1) {
      throw describeSettleFenceError(database, input.id, "uncertain", expectedEpoch, expectedAttemptCount);
    }
    return rowToEffectRecord(database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row);
  });
}

/**
 * Quarantines an already-attempted (`attempt_count >= 1`) `prepared` retry row directly
 * to `uncertain` without dispatching it again — used when a kind's current handler policy
 * forbids retries (at-most-once) so a prior attempt that may have succeeded externally is
 * neither replayed nor falsely marked `failed`.
 */
export function quarantinePreparedRetryAsUncertain(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    id: string;
    daemonGeneration: number;
    error: string;
    nowIso?: string;
  },
): EffectRecord {
  const daemonGeneration = assertPositiveEpoch(input.daemonGeneration, "daemonGeneration");
  const errorText = truncateEffectError(input.error);
  const nowIso = input.nowIso ?? new Date().toISOString();
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    const row = database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row | undefined;
    if (!row) throw new EffectFenceError(`Unknown effect ${input.id}.`);
    const current = rowToEffectRecord(row);
    if (current.state !== "prepared") {
      throw new EffectFenceError(`Effect ${input.id} cannot be quarantined from state ${current.state}.`);
    }
    if (current.attempt_count < 1) {
      throw new EffectFenceError(`Effect ${input.id} has never executed externally; cancel it as failed instead of marking uncertain.`);
    }
    if (current.epoch > daemonGeneration) {
      throw new EffectFenceError(
        `Stale daemon generation ${daemonGeneration} cannot quarantine effect ${input.id} owned by epoch ${current.epoch}.`,
      );
    }
    const result = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'uncertain',
          epoch = ?,
          next_attempt_at_ms = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND state = 'prepared' AND attempt_count >= 1 AND epoch = ?
    `).run(daemonGeneration, errorText, nowIso, input.id, current.epoch);
    if (Number(result.changes) !== 1) {
      throw new EffectFenceError(`Effect ${input.id} lost its prepared-retry quarantine fence.`);
    }
    return rowToEffectRecord(database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row);
  });
}

/** Settles an `uncertain` effect after external verification or explicit operator resolution. */
export function resolveUncertainEffect(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    id: string;
    daemonGeneration: number;
    state: "completed" | "failed";
    outcome?: unknown;
    error?: string;
    nowIso?: string;
  },
): EffectRecord {
  const daemonGeneration = assertPositiveEpoch(input.daemonGeneration, "daemonGeneration");
  const outcomeJson = serializeEffectOutcome(input.outcome);
  const errorText = input.state === "failed"
    ? truncateEffectError(input.error ?? "Uncertain effect resolved as failed.")
    : null;
  const nowIso = input.nowIso ?? new Date().toISOString();
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    const row = database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row | undefined;
    if (!row) throw new EffectFenceError(`Unknown effect ${input.id}.`);
    const current = rowToEffectRecord(row);
    if (current.state !== "uncertain") {
      throw new EffectFenceError(`Effect ${input.id} is in state ${current.state}, not uncertain.`);
    }
    if (current.epoch > daemonGeneration) {
      throw new EffectFenceError(
        `Stale daemon generation ${daemonGeneration} cannot resolve uncertain effect ${input.id} owned by epoch ${current.epoch}.`,
      );
    }
    const result = database.prepare(`
      UPDATE ${TABLE}
      SET state = ?,
          epoch = ?,
          outcome = ?,
          last_error = ?,
          next_attempt_at_ms = NULL,
          updated_at = ?
      WHERE id = ? AND state = 'uncertain' AND epoch = ?
    `).run(input.state, daemonGeneration, outcomeJson, errorText, nowIso, input.id, current.epoch);
    if (Number(result.changes) !== 1) {
      throw new EffectFenceError(`Effect ${input.id} lost its uncertain-resolution fence.`);
    }
    return rowToEffectRecord(database.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(input.id) as Row);
  });
}

/**
 * Atomic startup recovery pass executed by a newly elected daemon generation
 * before serving requests:
 * - Never blocks daemon startup if the external generation file was reset behind
 *   historical DB epochs (`epoch > daemonGeneration`); instead fences those rows
 *   fail-closed without lowering `epoch` or replaying external actions:
 *   `executing` and previously attempted `prepared` rows (`attempt_count >= 1`)
 *   become `uncertain`, unattempted `prepared` rows (`attempt_count = 0`) fail
 *   closed before dispatch, and `uncertain` rows stay `uncertain`.
 * - Requeues interrupted `executing` rows ONLY when `retryable = 1`, the kind is
 *   not listed in `nonRetryableKinds`, and `attempt_count < max_attempts`,
 *   preserving their exact idempotency key and payload.
 * - Marks every other interrupted `executing` row `uncertain` so non-idempotent
 *   external side effects are never replayed automatically.
 * - Quarantines any already-attempted `prepared` retry (`attempt_count >= 1`)
 *   whose kind is listed in `nonRetryableKinds` directly to `uncertain`.
 */
export function recoverInterruptedEffectsOnStartup(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    daemonGeneration: number;
    nowMs: number;
    nowIso?: string;
    nonRetryableKinds?: readonly string[];
  },
): EffectStartupRecoveryReport {
  const daemonGeneration = assertPositiveEpoch(input.daemonGeneration, "daemonGeneration");
  const nowIso = input.nowIso ?? new Date(input.nowMs).toISOString();
  const nonRetryableKinds = new Set(input.nonRetryableKinds ?? []);
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    const requeuedIds: string[] = [];
    const uncertainIds: string[] = [];
    const fencedFutureEpochIds: string[] = [];
    const fencedOrphanPreparedIds: string[] = [];
    const uncertainAgentIds = new Set<string>();

    // 1. Fence any non-terminal rows whose stored epoch exceeds the current
    //    daemon generation (for example after the generation file beside the DB
    //    was lost or reset) without bricking daemon startup or lowering `epoch`.
    const futureRows = database.prepare(`
      SELECT * FROM ${TABLE}
      WHERE state IN ('prepared', 'executing', 'uncertain') AND epoch > ?
      ORDER BY created_at, id
    `).all(daemonGeneration) as Row[];
    const futureUncertainStmt = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'uncertain',
          next_attempt_at_ms = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND state IN ('prepared', 'executing')
    `);
    const futureFailPreparedStmt = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'failed',
          next_attempt_at_ms = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND state = 'prepared' AND attempt_count = 0
    `);
    for (const row of futureRows) {
      const effect = rowToEffectRecord(row);
      fencedFutureEpochIds.push(effect.id);
      if (effect.state === "executing" || (effect.state === "prepared" && effect.attempt_count >= 1)) {
        futureUncertainStmt.run(
          `Daemon started at generation ${daemonGeneration} below stored effect epoch ${effect.epoch}; marked uncertain without replay.`,
          nowIso,
          effect.id,
        );
        uncertainIds.push(effect.id);
        uncertainAgentIds.add(effect.agent_id);
      } else if (effect.state === "prepared") {
        futureFailPreparedStmt.run(
          `Daemon started at generation ${daemonGeneration} below stored effect epoch ${effect.epoch}; refused execution before dispatch.`,
          nowIso,
          effect.id,
        );
      }
    }

    // 2. Recover interrupted `executing` rows from the current or earlier generations.
    const interrupted = database.prepare(`
      SELECT * FROM ${TABLE}
      WHERE state = 'executing' AND epoch <= ?
      ORDER BY created_at, id
    `).all(daemonGeneration) as Row[];

    const requeueStmt = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'prepared',
          epoch = ?,
          outcome = NULL,
          next_attempt_at_ms = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND state = 'executing' AND retryable = 1
    `);
    const uncertainStmt = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'uncertain',
          epoch = ?,
          next_attempt_at_ms = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND state = 'executing'
    `);

    for (const row of interrupted) {
      const effect = rowToEffectRecord(row);
      const kindAllowsRetry = !nonRetryableKinds.has(effect.kind);
      if (effect.retryable && kindAllowsRetry && effect.attempt_count < effect.max_attempts) {
        requeueStmt.run(
          daemonGeneration,
          input.nowMs,
          "Daemon restarted while retryable external effect was executing; scheduled for idempotent retry.",
          nowIso,
          effect.id,
        );
        requeuedIds.push(effect.id);
      } else {
        const message = effect.kind === BOUNDED_MCP_EFFECT_KIND
          ? "Room delivery restarted after this mutating tool crossed its execution boundary. It may have completed; verify external state before repeating it."
          : !effect.retryable || !kindAllowsRetry
            ? "Daemon restarted while non-idempotent external effect was executing; outcome is uncertain and was not replayed automatically. It may have completed; verify external state before repeating it."
            : "Daemon restarted while external effect was executing and maximum attempts were reached; outcome is uncertain.";
        uncertainStmt.run(daemonGeneration, message, nowIso, effect.id);
        uncertainIds.push(effect.id);
        uncertainAgentIds.add(effect.agent_id);
      }
    }

    // 3. Quarantine any already-attempted `prepared` retry rows whose policy is
    //    non-retryable (either row-level `retryable = 0` or handler-level
    //    `nonRetryableKinds`) so they are never replayed automatically.
    const kindList = [...nonRetryableKinds];
    const quarantinePredicate = kindList.length > 0
      ? `(retryable = 0 OR kind IN (${kindList.map(() => "?").join(", ")}))`
      : "retryable = 0";
    const preparedRetries = database.prepare(`
      SELECT * FROM ${TABLE}
      WHERE state = 'prepared'
        AND attempt_count >= 1
        AND epoch <= ?
        AND ${quarantinePredicate}
      ORDER BY created_at, id
    `).all(daemonGeneration, ...kindList) as Row[];
    const quarantineStmt = database.prepare(`
      UPDATE ${TABLE}
      SET state = 'uncertain',
          epoch = ?,
          next_attempt_at_ms = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND state = 'prepared' AND attempt_count >= 1
    `);
    for (const row of preparedRetries) {
      const effect = rowToEffectRecord(row);
      quarantineStmt.run(
        daemonGeneration,
        `Effect kind ${effect.kind} is now non-retryable (at-most-once); refusing replay after ${effect.attempt_count} prior attempt(s) and marking uncertain.`,
        nowIso,
        effect.id,
      );
      uncertainIds.push(effect.id);
      uncertainAgentIds.add(effect.agent_id);
    }

    // 4. Orphan cleanup for on-demand bounded MCP `prepared` rows (separate from
    //    background pump policy): a surviving, exactly authorized turn may keep
    //    its prepared row until exact retry or turn settlement, whereas a
    //    prepared row whose owning turn (or room move) already lost durable
    //    authority is failed closed here so no unowned `prepared` row lingers.
    //    Already-attempted mutations were quarantined to `uncertain` above and
    //    are never failed here.
    const hasTurnAuthorityTables = Boolean(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'supervised_agent_provider_turn_bindings'").get(),
    );
    const preparedBounded = hasTurnAuthorityTables
      ? database.prepare(`
          SELECT * FROM ${TABLE}
          WHERE state = 'prepared'
            AND kind = ?
            AND epoch <= ?
          ORDER BY created_at, id
        `).all(BOUNDED_MCP_EFFECT_KIND, daemonGeneration) as Row[]
      : [];
    if (preparedBounded.length > 0) {
      const failOrphanStmt = database.prepare(`
        UPDATE ${TABLE}
        SET state = 'failed',
            epoch = ?,
            next_attempt_at_ms = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ? AND state = 'prepared'
      `);
      for (const row of preparedBounded) {
        const decoded = rowToBoundedMcpEffect(row);
        if (decoded.mutation && decoded.attempt_count >= 1) continue;
        if (decoded.tool_name === "join_room") {
          const activeMove = database.prepare(`
            SELECT 1 FROM agent_room_moves
            WHERE effect_id = ? AND agent_id = ? AND phase NOT IN ('active', 'failed')
            LIMIT 1
          `).get(decoded.effect_id, decoded.agent_id);
          if (!activeMove) {
            failOrphanStmt.run(
              daemonGeneration,
              "The room move owning this prepared join_room effect is no longer active.",
              nowIso,
              decoded.effect_id,
            );
            fencedOrphanPreparedIds.push(decoded.effect_id);
          }
          continue;
        }
        if (!boundedMcpEffectTurnHasActiveAuthority(database, decoded)) {
          failOrphanStmt.run(
            daemonGeneration,
            "The supervised turn lost active authority before this prepared effect executed.",
            nowIso,
            decoded.effect_id,
          );
          fencedOrphanPreparedIds.push(decoded.effect_id);
        }
      }
    }

    // 5. Fence any unstarted generation-scoped async RPC `prepared` rows from
    //    this or earlier generations: async RPC callers bind to one daemon
    //    generation and never replay across a daemon restart (and secret-bearing
    //    invocations like `rpc_install_host_grant` keep their bearer in memory only).
    const preparedAsyncRpc = database.prepare(`
      SELECT id FROM ${TABLE}
      WHERE state = 'prepared'
        AND epoch <= ?
        AND kind IN (${ASYNC_RPC_EFFECT_KINDS.map(() => "?").join(", ")})
      ORDER BY created_at, id
    `).all(daemonGeneration, ...ASYNC_RPC_EFFECT_KINDS) as Row[];
    if (preparedAsyncRpc.length > 0) {
      const failStaleRpcStmt = database.prepare(`
        UPDATE ${TABLE}
        SET state = 'failed',
            epoch = ?,
            next_attempt_at_ms = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ? AND state = 'prepared'
      `);
      for (const row of preparedAsyncRpc) {
        const effectId = String(row.id);
        failStaleRpcStmt.run(
          daemonGeneration,
          "Daemon restarted before this generation-scoped RPC effect started.",
          nowIso,
          effectId,
        );
        fencedOrphanPreparedIds.push(effectId);
      }
    }

    const preparedRows = database.prepare(`
      SELECT id FROM ${TABLE}
      WHERE state = 'prepared'
      ORDER BY COALESCE(next_attempt_at_ms, 0), created_at, id
    `).all() as Row[];
    const allUncertainRows = database.prepare(`
      SELECT id FROM ${TABLE}
      WHERE state = 'uncertain'
      ORDER BY created_at, id
    `).all() as Row[];

    return {
      requeuedIds,
      uncertainIds,
      fencedFutureEpochIds,
      fencedOrphanPreparedIds,
      uncertainAgentIds: [...uncertainAgentIds],
      preparedIds: preparedRows.map((row) => String(row.id)),
      allUncertainIds: allUncertainRows.map((row) => String(row.id)),
    };
  });
}

/** Deletes all effect journal rows for a purged agent inside an active transaction. */
export function deleteEffectsForAgentInTransaction(database: DatabaseSync, agentId: string): number {
  if (!database.isTransaction) {
    throw new EffectFenceError("deleteEffectsForAgentInTransaction requires an active fenced SQLite transaction.");
  }
  const result = database.prepare(`DELETE FROM ${TABLE} WHERE agent_id = ?`).run(agentId);
  return Number(result.changes);
}

function describeSettleFenceError(
  database: DatabaseSync,
  id: string,
  targetState: EffectState,
  expectedEpoch: number,
  expectedAttemptCount: number,
): EffectFenceError {
  const row = database.prepare(`SELECT state, epoch, attempt_count FROM ${TABLE} WHERE id = ?`).get(id) as Row | undefined;
  if (!row) return new EffectFenceError(`Unknown effect ${id}.`);
  return new EffectFenceError(
    `Effect ${id} cannot transition to ${targetState}: expected (executing, epoch=${expectedEpoch}, attempt=${expectedAttemptCount}), `
      + `found (${String(row.state)}, epoch=${Number(row.epoch)}, attempt=${Number(row.attempt_count)}).`,
  );
}
