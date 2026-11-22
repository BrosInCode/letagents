/**
 * Bounded MCP effect helpers for the unified `effects` journal.
 *
 * All bounded MCP tool calls (reads, mutations, local reply receipts,
 * structured Cursor completions, and `join_room` preparations) share a single
 * `kind = "bounded_mcp_effect"` so SQLite's `UNIQUE(agent_id, kind, idempotency_key)`
 * enforces request-ID uniqueness across every tool category within one turn.
 *
 * Retry policy is enforced per row via `retryable` / `max_attempts` and the
 * `effects_immutable_identity` trigger:
 * - Mutating tools: `retryable = 0`, `max_attempts = 1` (at-most-once; never
 *   replayed after entering `executing`; crashes or ambiguous throws -> `uncertain`).
 * - Read-only tools: `retryable = 1`, `max_attempts = 8`, `autoPump = false`
 *   (on-demand only; never background-pumped without an active MCP caller).
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertPlainWireValue, canonicalizeJson } from "#daemon-contract/index.js";
import { EFFECT_JOURNAL_TABLE, type EffectState } from "./schema.js";
import {
  EffectFenceError,
  truncateEffectError,
} from "./types.js";

export const BOUNDED_MCP_EFFECT_KIND = "bounded_mcp_effect";
export const BOUNDED_MCP_MAX_READ_ATTEMPTS = 8;
export const BOUNDED_MCP_CLIENT_MESSAGE_ID_PREFIX = "bounded-effect:";

export type BoundedMcpEffectPayload = {
  room_id: string;
  execution_generation_id: string;
  provider_turn_id: string;
  mcp_request_id: string;
  tool_name: string;
  request: unknown;
  request_bytes: number;
  request_sha256: string;
  mutation: boolean;
};

export type BoundedMcpEffectView = {
  effect_id: string;
  agent_id: string;
  room_id: string;
  execution_generation_id: string;
  provider_turn_id: string;
  mcp_request_id: string;
  tool_name: string;
  request: unknown;
  request_bytes: number;
  request_sha256: string;
  mutation: boolean;
  state: EffectState;
  result: unknown;
  error: string | null;
  epoch: number;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
};

type Row = Record<string, unknown>;

/**
 * Deterministic 64-hex idempotency key for one bounded MCP tool request inside
 * one exact `(execution_generation_id, provider_turn_id, mcp_request_id)` tuple.
 */
export function boundedMcpEffectIdempotencyKey(
  executionGenerationId: string,
  providerTurnId: string,
  mcpRequestId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([executionGenerationId, providerTurnId, mcpRequestId]))
    .digest("hex");
}

/**
 * Deterministic `client_message_id` for bounded MCP `send_message` / `send_thread_message`
 * calls, derived from the durable `effect_id` and intentionally outside `internal:`
 * and `desktop-send:`.
 */
export function boundedMcpClientMessageId(effectId: string): string {
  const trimmed = effectId.trim();
  if (!trimmed) throw new Error("Bounded MCP client_message_id requires a durable effect_id.");
  return `${BOUNDED_MCP_CLIENT_MESSAGE_ID_PREFIX}${trimmed}`.slice(0, 240);
}

/** Builds the canonical JSON payload stored in `effects.payload` for a bounded MCP effect. */
export function serializeBoundedMcpPayload(input: {
  room_id: string;
  execution_generation_id: string;
  provider_turn_id: string;
  mcp_request_id: string;
  tool_name: string;
  request: unknown;
  requestJson: string;
  mutation: boolean;
}): { payload: BoundedMcpEffectPayload; payloadJson: string } {
  const requestBytes = Buffer.byteLength(input.requestJson, "utf8");
  const requestSha256 = createHash("sha256").update(input.requestJson).digest("hex");
  const payload: BoundedMcpEffectPayload = {
    room_id: input.room_id,
    execution_generation_id: input.execution_generation_id,
    provider_turn_id: input.provider_turn_id,
    mcp_request_id: input.mcp_request_id,
    tool_name: input.tool_name,
    request: input.request,
    request_bytes: requestBytes,
    request_sha256: requestSha256,
    mutation: input.mutation,
  };
  assertPlainWireValue(payload, "bounded_mcp_payload");
  const payloadJson = JSON.stringify(canonicalizeJson(payload));
  return { payload, payloadJson };
}

/** Decodes a unified `effects` row of kind `bounded_mcp_effect`. */
export function rowToBoundedMcpEffect(row: Row): BoundedMcpEffectView {
  const payload = JSON.parse(String(row.payload)) as BoundedMcpEffectPayload;
  return {
    effect_id: String(row.id),
    agent_id: String(row.agent_id),
    room_id: String(payload.room_id),
    execution_generation_id: String(payload.execution_generation_id),
    provider_turn_id: String(payload.provider_turn_id),
    mcp_request_id: String(payload.mcp_request_id),
    tool_name: String(payload.tool_name),
    request: payload.request,
    request_bytes: Number(payload.request_bytes),
    request_sha256: String(payload.request_sha256),
    mutation: Boolean(payload.mutation),
    state: String(row.state) as EffectState,
    result: row.outcome === null || row.outcome === undefined ? null : JSON.parse(String(row.outcome)),
    error: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    epoch: Number(row.epoch),
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * Classifies an error thrown during a mutating bounded MCP tool execution.
 *
 * Fail-closed policy:
 * - Only PROVEN pre-dispatch validation errors or definitive HTTP 4xx server
 *   rejections return `true` (safe to settle as `failed`).
 * - Any HTTP 5xx, transport/network/timeout error, or unmarked plain `Error`
 *   (including errors thrown by an older pinned MCP runtime after sending a
 *   request) returns `false` so the mutation settles as `uncertain` instead of
 *   risking a duplicate external side effect.
 */
export function isProvenBoundedMutationPreDispatchOr4xxError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    beforeExternalDispatch?: unknown;
  };
  if (candidate.beforeExternalDispatch === true) return true;
  if (candidate.name === "ZodError") return true;
  if (typeof candidate.status === "number"
    && Number.isInteger(candidate.status)
    && candidate.status >= 400
    && candidate.status < 500) {
    return true;
  }
  return false;
}

/**
 * Marks executing mutating bounded MCP effects as `uncertain` inside an active
 * runtime-recovery transaction while preserving monotonic `(epoch, attempt_count)`.
 */
export function markExecutingBoundedMutationsUncertainInTransaction(
  database: DatabaseSync,
  input: {
    agentId: string;
    executionGenerationId: string;
    providerTurnId?: string;
    error: string;
    updatedAt: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError("markExecutingBoundedMutationsUncertainInTransaction requires an active transaction.");
  }
  const errorText = truncateEffectError(input.error);
  const turnClause = input.providerTurnId !== undefined
    ? " AND json_extract(payload, '$.provider_turn_id') = ?"
    : "";
  const args: unknown[] = [
    errorText,
    input.updatedAt,
    input.agentId,
    BOUNDED_MCP_EFFECT_KIND,
    input.executionGenerationId,
  ];
  if (input.providerTurnId !== undefined) args.push(input.providerTurnId);
  const result = database.prepare(`
    UPDATE ${EFFECT_JOURNAL_TABLE}
    SET state = 'uncertain',
        last_error = ?,
        next_attempt_at_ms = NULL,
        updated_at = ?
    WHERE agent_id = ?
      AND kind = ?
      AND json_extract(payload, '$.execution_generation_id') = ?${turnClause}
      AND json_extract(payload, '$.mutation') = 1
      AND state = 'executing'
  `).run(...args as never[]);
  return Number(result.changes);
}

/**
 * Fails prepared non-`join_room` bounded MCP effects for one provider turn when
 * human turn control fences the turn before those effects are authorized to run.
 */
export function failPreparedBoundedEffectsForTurnControlInTransaction(
  database: DatabaseSync,
  input: {
    agentId: string;
    executionGenerationId: string;
    providerTurnId: string;
    error: string;
    updatedAt: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError("failPreparedBoundedEffectsForTurnControlInTransaction requires an active transaction.");
  }
  const result = database.prepare(`
    UPDATE ${EFFECT_JOURNAL_TABLE}
    SET state = 'failed',
        last_error = ?,
        next_attempt_at_ms = NULL,
        updated_at = ?
    WHERE agent_id = ?
      AND kind = ?
      AND json_extract(payload, '$.execution_generation_id') = ?
      AND json_extract(payload, '$.provider_turn_id') = ?
      AND state = 'prepared'
      AND json_extract(payload, '$.tool_name') <> 'join_room'
  `).run(
    truncateEffectError(input.error),
    input.updatedAt,
    input.agentId,
    BOUNDED_MCP_EFFECT_KIND,
    input.executionGenerationId,
    input.providerTurnId,
  );
  return Number(result.changes);
}

/**
 * Settles prepared and executing read-only non-`join_room` bounded MCP effects
 * when their owning provider turn reaches a terminal inbox state.
 */
export function settleBoundedEffectsForTerminalTurnInTransaction(
  database: DatabaseSync,
  input: {
    agentId: string;
    executionGenerationId: string;
    providerTurnId: string;
    error: string;
    updatedAt: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError("settleBoundedEffectsForTerminalTurnInTransaction requires an active transaction.");
  }
  const result = database.prepare(`
    UPDATE ${EFFECT_JOURNAL_TABLE}
    SET state = 'failed',
        last_error = ?,
        next_attempt_at_ms = NULL,
        updated_at = ?
    WHERE agent_id = ?
      AND kind = ?
      AND json_extract(payload, '$.execution_generation_id') = ?
      AND json_extract(payload, '$.provider_turn_id') = ?
      AND (state = 'prepared' OR (state = 'executing' AND json_extract(payload, '$.mutation') = 0))
      AND json_extract(payload, '$.tool_name') <> 'join_room'
  `).run(
    truncateEffectError(input.error),
    input.updatedAt,
    input.agentId,
    BOUNDED_MCP_EFFECT_KIND,
    input.executionGenerationId,
    input.providerTurnId,
  );
  return Number(result.changes);
}

/**
 * Fails a prepared `join_room` bounded MCP effect inside a lifecycle or
 * room-move transaction.
 */
export function failPreparedJoinRoomEffectInTransaction(
  database: DatabaseSync,
  input: {
    effectId: string;
    agentId: string;
    roomId: string;
    executionGenerationId: string;
    providerTurnId: string;
    error: string;
    updatedAt: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError("failPreparedJoinRoomEffectInTransaction requires an active transaction.");
  }
  const result = database.prepare(`
    UPDATE ${EFFECT_JOURNAL_TABLE}
    SET state = 'failed',
        outcome = NULL,
        last_error = ?,
        next_attempt_at_ms = NULL,
        updated_at = ?
    WHERE id = ?
      AND agent_id = ?
      AND kind = ?
      AND json_extract(payload, '$.room_id') = ?
      AND json_extract(payload, '$.execution_generation_id') = ?
      AND json_extract(payload, '$.provider_turn_id') = ?
      AND json_extract(payload, '$.tool_name') = 'join_room'
      AND state = 'prepared'
  `).run(
    truncateEffectError(input.error),
    input.updatedAt,
    input.effectId,
    input.agentId,
    BOUNDED_MCP_EFFECT_KIND,
    input.roomId,
    input.executionGenerationId,
    input.providerTurnId,
  );
  return Number(result.changes);
}

/**
 * Transitions a `prepared` effect to `completed` inside the caller's active
 * transaction while strictly respecting `effects_immutable_identity` by
 * claiming `prepared -> executing` (incrementing `attempt_count`) and then
 * settling `executing -> completed` atomically in the same transaction.
 */
export function completePreparedEffectAtomicallyInTransaction(
  database: DatabaseSync,
  input: {
    id: string;
    outcomeJson: string | null;
    updatedAt: string;
    minEpoch?: number;
  },
): void {
  if (!database.isTransaction) {
    throw new EffectFenceError("completePreparedEffectAtomicallyInTransaction requires an active transaction.");
  }
  const row = database.prepare(`SELECT state, epoch, attempt_count FROM ${EFFECT_JOURNAL_TABLE} WHERE id = ?`)
    .get(input.id) as Row | undefined;
  if (!row) throw new EffectFenceError(`Unknown effect ${input.id}.`);
  const state = String(row.state) as EffectState;
  const currentEpoch = Number(row.epoch);
  const nextEpoch = input.minEpoch !== undefined ? Math.max(currentEpoch, input.minEpoch) : currentEpoch;
  if (state === "prepared") {
    const claimed = database.prepare(`
      UPDATE ${EFFECT_JOURNAL_TABLE}
      SET state = 'executing',
          epoch = ?,
          attempt_count = attempt_count + 1,
          next_attempt_at_ms = NULL,
          updated_at = ?
      WHERE id = ? AND state = 'prepared'
    `).run(nextEpoch, input.updatedAt, input.id);
    if (Number(claimed.changes) !== 1) {
      throw new EffectFenceError(`Effect ${input.id} could not be claimed from prepared state.`);
    }
  } else if (state !== "executing") {
    throw new EffectFenceError(`Effect ${input.id} cannot complete atomically from state ${state}.`);
  }
  const completed = database.prepare(`
    UPDATE ${EFFECT_JOURNAL_TABLE}
    SET state = 'completed',
        epoch = ?,
        outcome = ?,
        last_error = NULL,
        next_attempt_at_ms = NULL,
        updated_at = ?
    WHERE id = ? AND state = 'executing'
  `).run(nextEpoch, input.outcomeJson, input.updatedAt, input.id);
  if (Number(completed.changes) !== 1) {
    throw new EffectFenceError(`Effect ${input.id} could not be completed from executing state.`);
  }
}

/**
 * Checks whether one bounded MCP effect's owning provider turn still holds
 * active durable authority (surviving running turn with matching binding, no
 * pending runtime recovery, and no unresolved turn-control barrier).
 */
export function boundedMcpEffectTurnHasActiveAuthority(
  database: DatabaseSync,
  effect: Pick<BoundedMcpEffectView, "agent_id" | "room_id" | "execution_generation_id" | "provider_turn_id">,
): boolean {
  const rows = database.prepare(`
    SELECT b.inbox_item_id, b.work_attempt_id, b.provider_continuation_id, i.state
    FROM supervised_agent_provider_turn_bindings b
    JOIN inbox_items i ON i.inbox_item_id = b.inbox_item_id
    WHERE b.agent_id = ?
      AND b.room_id = ?
      AND b.origin_execution_generation_id = ?
      AND b.provider_turn_id = ?
      AND i.agent_id = b.agent_id
      AND i.room_id = b.room_id
      AND i.provider_turn_id = b.provider_turn_id
  `).all(
    effect.agent_id,
    effect.room_id,
    effect.execution_generation_id,
    effect.provider_turn_id,
  ) as Row[];
  if (rows.length !== 1 || !["dispatching", "awaiting_result"].includes(String(rows[0]?.state))) {
    return false;
  }
  const binding = rows[0]!;
  const head = database.prepare(`
    SELECT inbox_item_id FROM inbox_items
    WHERE agent_id = ?
      AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
    ORDER BY fifo_sequence LIMIT 1
  `).get(effect.agent_id) as Row | undefined;
  if (!head || String(head.inbox_item_id) !== String(binding.inbox_item_id)) {
    return false;
  }
  const pendingRecovery = database.prepare(`
    SELECT 1 FROM agent_runtime_recoveries
    WHERE agent_id = ? AND phase IN ('prepared', 'stopped')
    LIMIT 1
  `).get(effect.agent_id);
  if (pendingRecovery) return false;
  const runtime = database.prepare(`
    SELECT room_id, desired_state, work_attempt_id, provider_work_attempt_id,
           provider_continuation_id, condition, turn_control_status
    FROM agents
    WHERE agent_id = ?
  `).get(effect.agent_id) as Row | undefined;
  if (!runtime
    || String(runtime.room_id) !== effect.room_id
    || String(runtime.desired_state) !== "running"
    || String(runtime.condition) !== "none"
    || runtime.work_attempt_id === null
    || String(runtime.work_attempt_id) !== String(binding.work_attempt_id)
    || runtime.provider_work_attempt_id === null
    || String(runtime.provider_work_attempt_id) !== String(binding.work_attempt_id)
    || String(runtime.provider_continuation_id) !== String(binding.provider_continuation_id)
    || ["prepared", "dispatching", "retryable", "uncertain"].includes(String(runtime.turn_control_status ?? ""))) {
    return false;
  }
  return true;
}
