/**
 * Execution approval publication outbound effect descriptors, idempotency keys,
 * atomic cancellation helpers, and bounded terminal retention on the unified
 * `effects` journal.
 *
 * Immutable publication custody pins, receipt digests, expiry bounds, and
 * capacity triggers remain in `execution_approval_publications`. The `effects`
 * table owns outbound HTTP dispatch durability, retry backoff
 * (`next_attempt_at_ms`), startup crash recovery, duplicate suppression, and
 * handoff fencing/drain for both `publishExecutionApproval` and
 * `closeExecutionApprovalPublication`.
 *
 * No supervisor grant, worker bearer, session token, projection JSON/diff
 * contents, or raw HTTP/provider error messages ever enter `effects.payload`,
 * `effects.outcome`, or `effects.last_error`.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { EFFECT_JOURNAL_TABLE } from "./schema.js";
import {
  failEffectInTransaction,
  getEffect,
  listEffectsForAgent,
  pruneTerminalEffectsByKindsInTransaction,
} from "./store.js";
import { EffectFenceError, type EffectRecord } from "./types.js";

export const EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND = "execution_approval_publish" as const;
export const EXECUTION_APPROVAL_CLOSE_EFFECT_KIND = "execution_approval_close" as const;
export const EXECUTION_APPROVAL_EFFECT_KINDS = [
  EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
  EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
] as const;

/**
 * High positive safe cap so offline desktops keep retrying optional approval
 * publications/closures every 30s until resolved or expired.
 */
export const EXECUTION_APPROVAL_EFFECT_MAX_ATTEMPTS = 1_000_000;

/** Bound terminal (`completed` / `failed`) approval-publication rows retained per agent in `effects`. */
export const EXECUTION_APPROVAL_RETAINED_TERMINAL_EFFECTS_PER_AGENT = 512;

export type ExecutionApprovalPublishEffectPayload = {
  room_id: string;
  delegation_instance_id: string;
  delegation_revision: number;
  request_id: string;
  request_version: number;
  projection_sha256: string;
};

export type ExecutionApprovalCloseEffectPayload = {
  room_id: string;
  delegation_instance_id: string;
  delegation_revision: number;
  request_id: string;
  request_version: number;
  publication_id: string;
  publication_digest: string;
};

export function executionApprovalPublishIdempotencyKey(input: {
  roomId: string;
  delegationInstanceId: string;
  delegationRevision: number;
  requestId: string;
  requestVersion: number;
  projectionSha256: string;
}): string {
  const hash = createHash("sha256").update(JSON.stringify([
    input.roomId,
    input.delegationInstanceId,
    input.delegationRevision,
    input.requestId,
    input.requestVersion,
    input.projectionSha256,
  ])).digest("hex");
  return `eap:v1:${hash}`;
}

export function executionApprovalCloseIdempotencyKey(input: {
  roomId: string;
  delegationInstanceId: string;
  delegationRevision: number;
  requestId: string;
  requestVersion: number;
  publicationId: string;
  publicationDigest: string;
}): string {
  const hash = createHash("sha256").update(JSON.stringify([
    input.roomId,
    input.delegationInstanceId,
    input.delegationRevision,
    input.requestId,
    input.requestVersion,
    input.publicationId,
    input.publicationDigest,
  ])).digest("hex");
  return `eac:v1:${hash}`;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInt32(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}

export function parseExecutionApprovalPublishEffectPayload(
  payload: unknown,
): ExecutionApprovalPublishEffectPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (!isNonEmptyString(raw.room_id)
    || !isNonEmptyString(raw.delegation_instance_id)
    || !isPositiveInt32(raw.delegation_revision)
    || !isNonEmptyString(raw.request_id)
    || !isPositiveInt32(raw.request_version)
    || !isSha256(raw.projection_sha256)) {
    return null;
  }
  return {
    room_id: raw.room_id,
    delegation_instance_id: raw.delegation_instance_id,
    delegation_revision: raw.delegation_revision,
    request_id: raw.request_id,
    request_version: raw.request_version,
    projection_sha256: raw.projection_sha256,
  };
}

export function parseExecutionApprovalCloseEffectPayload(
  payload: unknown,
): ExecutionApprovalCloseEffectPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (!isNonEmptyString(raw.room_id)
    || !isNonEmptyString(raw.delegation_instance_id)
    || !isPositiveInt32(raw.delegation_revision)
    || !isNonEmptyString(raw.request_id)
    || !isPositiveInt32(raw.request_version)
    || !isNonEmptyString(raw.publication_id)
    || !isSha256(raw.publication_digest)) {
    return null;
  }
  return {
    room_id: raw.room_id,
    delegation_instance_id: raw.delegation_instance_id,
    delegation_revision: raw.delegation_revision,
    request_id: raw.request_id,
    request_version: raw.request_version,
    publication_id: raw.publication_id,
    publication_digest: raw.publication_digest,
  };
}

export function listActiveExecutionApprovalEffectsForAgent(
  database: DatabaseSync,
  agentId: string,
): EffectRecord[] {
  return [
    ...listEffectsForAgent(database, agentId, {
      kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
      states: ["prepared", "executing"],
    }),
    ...listEffectsForAgent(database, agentId, {
      kind: EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
      states: ["prepared", "executing"],
    }),
  ];
}

export function hasInterruptedExecutionApprovalEffects(database: DatabaseSync): boolean {
  return Boolean(database.prepare(`
    SELECT 1 FROM ${EFFECT_JOURNAL_TABLE}
    WHERE kind IN (?, ?) AND state = 'executing'
    LIMIT 1
  `).get(EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND, EXECUTION_APPROVAL_CLOSE_EFFECT_KIND));
}

export function pruneTerminalExecutionApprovalEffectsInTransaction(
  database: DatabaseSync,
  agentId: string,
  maxRetained = EXECUTION_APPROVAL_RETAINED_TERMINAL_EFFECTS_PER_AGENT,
): number {
  return pruneTerminalEffectsByKindsInTransaction(
    database,
    agentId,
    EXECUTION_APPROVAL_EFFECT_KINDS,
    maxRetained,
  );
}

/**
 * Cancels every `prepared` approval-publication effect in `effectIds` inside
 * an already-open fenced write transaction so local domain terminalization
 * (`expired` / `invalid` / `conflict`) and effect cancellation commit
 * atomically. Throws `EffectFenceError` if any referenced effect is still
 * `executing` or owned by a newer epoch.
 */
export function cancelPreparedExecutionApprovalEffectsInTransaction(
  database: DatabaseSync,
  input: {
    effectIds: readonly string[];
    expectedEpoch: number;
    error: string;
    nowIso: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError(
      "cancelPreparedExecutionApprovalEffectsInTransaction requires an active fenced SQLite transaction.",
    );
  }
  let cancelled = 0;
  for (const id of input.effectIds) {
    const current = getEffect(database, id);
    if (!current || current.state === "completed" || current.state === "failed") continue;
    if (current.state !== "prepared") {
      throw new EffectFenceError(
        `Execution approval effect ${id} cannot be cancelled while in state ${current.state}.`,
      );
    }
    failEffectInTransaction(database, {
      id,
      expectedEpoch: input.expectedEpoch,
      error: input.error,
      nowIso: input.nowIso,
    });
    cancelled += 1;
  }
  return cancelled;
}
