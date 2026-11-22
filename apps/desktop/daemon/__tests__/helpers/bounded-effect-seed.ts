import type { DatabaseSync } from "node:sqlite";
import {
  BOUNDED_MCP_EFFECT_KIND,
  BOUNDED_MCP_MAX_READ_ATTEMPTS,
  boundedMcpEffectIdempotencyKey,
  serializeBoundedMcpPayload,
  type EffectState,
} from "../../effect-journal/index.js";

/** Seeds a valid v3 `bounded_mcp_effect` row directly into the unified `effects` table for tests. */
export function seedBoundedMcpEffectRow(
  database: DatabaseSync,
  input: {
    id: string;
    agent_id: string;
    room_id: string;
    execution_generation_id: string;
    provider_turn_id: string;
    mcp_request_id: string;
    tool_name: string;
    request?: unknown;
    mutation?: boolean;
    state: EffectState;
    outcome?: unknown;
    error?: string | null;
    epoch?: number;
    retryable?: boolean;
    attempt_count?: number;
    max_attempts?: number;
    created_at?: string;
    updated_at?: string;
  },
): void {
  const request = input.request ?? {};
  const requestJson = JSON.stringify(request);
  const mutation = input.mutation ?? true;
  const { payloadJson } = serializeBoundedMcpPayload({
    room_id: input.room_id,
    execution_generation_id: input.execution_generation_id,
    provider_turn_id: input.provider_turn_id,
    mcp_request_id: input.mcp_request_id,
    tool_name: input.tool_name,
    request,
    requestJson,
    mutation,
  });
  const idempotencyKey = boundedMcpEffectIdempotencyKey(
    input.execution_generation_id,
    input.provider_turn_id,
    input.mcp_request_id,
  );
  const retryable = input.retryable ?? (!mutation || (input.tool_name === "complete_room_turn" && input.state !== "completed"));
  const maxAttempts = input.max_attempts ?? (retryable ? BOUNDED_MCP_MAX_READ_ATTEMPTS : 1);
  const attemptCount = input.attempt_count ?? (input.state === "prepared" ? 0 : 1);
  const outcomeJson = input.outcome === undefined || input.outcome === null ? null : JSON.stringify(input.outcome);
  const now = input.created_at ?? new Date().toISOString();
  const updatedAt = input.updated_at ?? now;
  database.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(
    input.id,
    input.agent_id,
    BOUNDED_MCP_EFFECT_KIND,
    idempotencyKey,
    input.epoch ?? 1,
    input.state,
    payloadJson,
    outcomeJson,
    retryable ? 1 : 0,
    attemptCount,
    maxAttempts,
    input.error ?? null,
    now,
    updatedAt,
  );
}
