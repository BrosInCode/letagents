import { createHash } from "node:crypto";
import type { SupervisedEffectRecord, Row } from "./types.js";

export class EffectAuthorityError extends Error {}
export const MAX_EFFECTS_PER_PROVIDER_TURN = 128;
export const MAX_UNRESOLVED_EFFECTS_PER_AGENT = 128;
export const MAX_EFFECT_REQUEST_BYTES = 64 * 1024;
export const MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN = 512 * 1024;
export const MAX_EFFECT_RESULT_BYTES = 256 * 1024;
export const MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN = 1024 * 1024;
export const MAX_EFFECT_ERROR_BYTES = 16 * 1024;

export function serializeEffectJson(value: unknown, label: string): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error(`A supervised effect ${label} must be JSON-serializable.`); }
  if (serialized === undefined) throw new Error(`A supervised effect ${label} must be a JSON value.`);
  return serialized;
}

export function effectRequestFingerprint(requestJson: string): string {
  return createHash("sha256").update(requestJson).digest("hex");
}

export function truncateEffectError(error: string): string {
  if (Buffer.byteLength(error, "utf8") <= MAX_EFFECT_ERROR_BYTES) return error;
  const suffix = "… [truncated]";
  const prefixBytes = MAX_EFFECT_ERROR_BYTES - Buffer.byteLength(suffix, "utf8");
  const prefix = Buffer.from(error, "utf8").subarray(0, prefixBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  return `${prefix}${suffix}`;
}

export function rowToEffect(row: Row): SupervisedEffectRecord {
  return {
    effect_id: String(row.effect_id), agent_id: String(row.agent_id), room_id: String(row.room_id),
    execution_generation_id: String(row.execution_generation_id), provider_turn_id: String(row.provider_turn_id),
    mcp_request_id: String(row.mcp_request_id), tool_name: String(row.tool_name), request: JSON.parse(String(row.request_json)),
    mutation: Number(row.mutation) === 1,
    state: String(row.state) as SupervisedEffectRecord["state"],
    result: row.result_json === null ? null : JSON.parse(String(row.result_json)),
    error: row.error === null ? null : String(row.error),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

export function rowToTombstonedEffect(row: Row): SupervisedEffectRecord {
  return {
    effect_id: String(row.effect_id), agent_id: String(row.agent_id), room_id: String(row.room_id),
    execution_generation_id: String(row.execution_generation_id), provider_turn_id: String(row.provider_turn_id),
    mcp_request_id: String(row.mcp_request_id), tool_name: String(row.tool_name), request: null,
    mutation: Number(row.mutation) === 1,
    state: String(row.state) as SupervisedEffectRecord["state"],
    result: row.result_json === null ? null : JSON.parse(String(row.result_json)),
    error: row.error === null ? null : String(row.error),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}
