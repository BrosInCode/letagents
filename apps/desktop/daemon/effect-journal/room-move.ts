/**
 * Room-move outbound HTTP sub-action descriptors, idempotency keys, phase
 * authorization checks, and bounded terminal retention on the unified
 * `effects` journal.
 *
 * The multi-phase room-move saga (`agent_room_moves`), manifest membership
 * transitions, Electron source-revocation handshakes, and inbox queue/cursor
 * commits remain owned by `RoomMoveCoordinator` + `ManifestStore`. The
 * `effects` journal + `EffectExecutor` own the three outbound HTTP sub-actions:
 * - `room_move_join_destination` (`deliveryHttp.joinRoom` -> destination room)
 * - `room_move_rollback_source` (`deliveryHttp.joinRoom` -> source room)
 * - `room_move_bootstrap_tail` (`deliveryHttp.latest` -> destination tail cursor)
 *
 * No bearer credentials, supervisor grants, or raw room message contents ever
 * enter `effects.payload`, `effects.outcome`, or `effects.last_error`.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { pruneTerminalEffectsByKindsInTransaction } from "./store.js";

export const ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND = "room_move_join_destination" as const;
export const ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND = "room_move_rollback_source" as const;
export const ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND = "room_move_bootstrap_tail" as const;
export const ROOM_MOVE_EFFECT_KINDS = [
  ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
  ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
  ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
] as const;

export const ROOM_MOVE_EFFECT_MAX_ATTEMPTS = 1_000_000;
export const ROOM_MOVE_RETAINED_TERMINAL_EFFECTS_PER_AGENT = 512;

export type RoomMoveJoinDestinationEffectPayload = {
  operation_id: string;
  source_room_id: string;
  destination_room_id: string;
  work_attempt_id: string | null;
  execution_generation_id: string | null;
};

export type RoomMoveRollbackSourceEffectPayload = {
  operation_id: string;
  source_room_id: string;
  destination_room_id: string;
  work_attempt_id: string | null;
  execution_generation_id: string | null;
};

export type RoomMoveBootstrapTailEffectPayload = {
  operation_id: string;
  destination_room_id: string;
  work_attempt_id: string | null;
  execution_generation_id: string | null;
};

export function roomMoveJoinDestinationIdempotencyKey(input: {
  operationId: string;
  destinationRoomId: string;
}): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([input.operationId, input.destinationRoomId]))
    .digest("hex");
  return `rmj:v1:${hash}`;
}

export function roomMoveRollbackSourceIdempotencyKey(input: {
  operationId: string;
  sourceRoomId: string;
}): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([input.operationId, input.sourceRoomId]))
    .digest("hex");
  return `rmr:v1:${hash}`;
}

export function roomMoveBootstrapTailIdempotencyKey(input: {
  operationId: string;
  destinationRoomId: string;
}): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([input.operationId, input.destinationRoomId]))
    .digest("hex");
  return `rmt:v1:${hash}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parseRoomMoveJoinDestinationPayload(
  payload: unknown,
): RoomMoveJoinDestinationEffectPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (!isNonEmptyString(raw.operation_id)
    || !isNonEmptyString(raw.source_room_id)
    || !isNonEmptyString(raw.destination_room_id)
    || !isNullableString(raw.work_attempt_id)
    || !isNullableString(raw.execution_generation_id)) {
    return null;
  }
  return {
    operation_id: raw.operation_id,
    source_room_id: raw.source_room_id,
    destination_room_id: raw.destination_room_id,
    work_attempt_id: raw.work_attempt_id,
    execution_generation_id: raw.execution_generation_id,
  };
}

export function parseRoomMoveRollbackSourcePayload(
  payload: unknown,
): RoomMoveRollbackSourceEffectPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (!isNonEmptyString(raw.operation_id)
    || !isNonEmptyString(raw.source_room_id)
    || !isNonEmptyString(raw.destination_room_id)
    || !isNullableString(raw.work_attempt_id)
    || !isNullableString(raw.execution_generation_id)) {
    return null;
  }
  return {
    operation_id: raw.operation_id,
    source_room_id: raw.source_room_id,
    destination_room_id: raw.destination_room_id,
    work_attempt_id: raw.work_attempt_id,
    execution_generation_id: raw.execution_generation_id,
  };
}

export function parseRoomMoveBootstrapTailPayload(
  payload: unknown,
): RoomMoveBootstrapTailEffectPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (!isNonEmptyString(raw.operation_id)
    || !isNonEmptyString(raw.destination_room_id)
    || !isNullableString(raw.work_attempt_id)
    || !isNullableString(raw.execution_generation_id)) {
    return null;
  }
  return {
    operation_id: raw.operation_id,
    destination_room_id: raw.destination_room_id,
    work_attempt_id: raw.work_attempt_id,
    execution_generation_id: raw.execution_generation_id,
  };
}

/**
 * Synchronously validates the durable `agent_room_moves` saga row inside a
 * claim or settlement transaction when the table is present in SQLite. Returns
 * `null` when valid (or when running in a minimal unit harness without
 * `agent_room_moves`), or a refusal string when the saga row is missing,
 * terminal, or no longer matches the expected phase/runtime coordinates.
 */
export function checkRoomMoveSagaPhaseInTransaction(
  database: DatabaseSync,
  input: {
    operationId: string;
    agentId: string;
    workAttemptId: string | null;
    executionGenerationId: string | null;
    allowedPhases: readonly string[];
  },
): string | null {
  const hasRoomMovesTable = Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_room_moves'").get(),
  );
  if (!hasRoomMovesTable) return null;
  const row = database.prepare(`
    SELECT agent_id, phase, work_attempt_id, execution_generation_id
    FROM agent_room_moves
    WHERE operation_id = ?
  `).get(input.operationId) as Record<string, unknown> | undefined;
  if (!row) return "Room move operation no longer exists.";
  if (String(row.agent_id) !== input.agentId) return "Room move agent identity mismatch.";
  if (!input.allowedPhases.includes(String(row.phase))) {
    return `Room move operation is in phase ${String(row.phase)} and no longer allows this sub-action.`;
  }
  const storedWorkAttempt = row.work_attempt_id === null || row.work_attempt_id === undefined
    ? null
    : String(row.work_attempt_id);
  const storedExecutionGen = row.execution_generation_id === null || row.execution_generation_id === undefined
    ? null
    : String(row.execution_generation_id);
  if (storedWorkAttempt !== input.workAttemptId || storedExecutionGen !== input.executionGenerationId) {
    return "Room move runtime coordinates no longer match.";
  }
  return null;
}

export function pruneTerminalRoomMoveEffectsInTransaction(
  database: DatabaseSync,
  agentId: string,
  maxRetained = ROOM_MOVE_RETAINED_TERMINAL_EFFECTS_PER_AGENT,
): number {
  return pruneTerminalEffectsByKindsInTransaction(
    database,
    agentId,
    ROOM_MOVE_EFFECT_KINDS,
    maxRetained,
  );
}
