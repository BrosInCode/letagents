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
  withFencedEffectTransaction,
} from "./store.js";
import { assertPositiveEpoch, EffectFenceError, type EffectRecord } from "./types.js";

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

export type ExecutionApprovalPublicationIdentity = {
  roomId: string;
  delegationInstanceId: string;
  delegationRevision: number;
  requestId: string;
  requestVersion: number;
};

function publicationIdentityKey(identity: ExecutionApprovalPublicationIdentity): string {
  return JSON.stringify([
    identity.roomId,
    identity.delegationInstanceId,
    identity.delegationRevision,
    identity.requestId,
    identity.requestVersion,
  ]);
}

function effectPublicationIdentity(effect: EffectRecord): ExecutionApprovalPublicationIdentity | null {
  if (effect.kind === EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND) {
    const parsed = parseExecutionApprovalPublishEffectPayload(effect.payload);
    if (!parsed) return null;
    return {
      roomId: parsed.room_id,
      delegationInstanceId: parsed.delegation_instance_id,
      delegationRevision: parsed.delegation_revision,
      requestId: parsed.request_id,
      requestVersion: parsed.request_version,
    };
  }
  if (effect.kind === EXECUTION_APPROVAL_CLOSE_EFFECT_KIND) {
    const parsed = parseExecutionApprovalCloseEffectPayload(effect.payload);
    if (!parsed) return null;
    return {
      roomId: parsed.room_id,
      delegationInstanceId: parsed.delegation_instance_id,
      delegationRevision: parsed.delegation_revision,
      requestId: parsed.request_id,
      requestVersion: parsed.request_version,
    };
  }
  return null;
}

function hasTable(database: DatabaseSync, tableName: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

/**
 * Returns whether `agentId` currently has a non-terminal room move whose
 * compensation can still restore the source room and authority. Missing
 * `agent_room_moves` (minimal standalone test DBs) returns `false`; unexpected
 * SQLite storage errors propagate so callers fail closed.
 */
export function hasPendingRoomMoveForAgent(database: DatabaseSync, agentId: string): boolean {
  try {
    return Boolean(database.prepare(`
      SELECT 1 FROM agent_room_moves
      WHERE agent_id = ? AND phase NOT IN ('active', 'failed')
      LIMIT 1
    `).get(agentId));
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return false;
    }
    throw error;
  }
}

/**
 * Atomically retires `prepared` approval-publication effects and invalidates
 * pending `execution_approval_publications` rows for `(agentId, roomId)` when
 * a room move commits to terminal `active`. Any live `executing` effect (and
 * its matching publication row) is left untouched so in-flight settlement
 * fences cleanly via origin mismatch.
 */
export function retireExecutionApprovalEffectsForRoomMoveInTransaction(
  database: DatabaseSync,
  input: {
    agentId: string;
    expectedEpoch: number;
    roomId: string;
    error: string;
    nowIso?: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError(
      "retireExecutionApprovalEffectsForRoomMoveInTransaction requires an active fenced SQLite transaction.",
    );
  }
  const epoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const nowIso = input.nowIso ?? new Date().toISOString();
  const preparedRows = database.prepare(`
    SELECT id FROM ${EFFECT_JOURNAL_TABLE}
    WHERE agent_id = ?
      AND kind IN (?, ?)
      AND state = 'prepared'
      AND json_extract(payload, '$.room_id') = ?
    ORDER BY created_at ASC, id ASC
  `).all(
    input.agentId,
    EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
    EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
    input.roomId,
  ) as Array<{ id: string }>;
  for (const row of preparedRows) {
    failEffectInTransaction(database, {
      id: String(row.id),
      expectedEpoch: epoch,
      error: input.error,
      nowIso,
    });
  }
  if (hasTable(database, "execution_approval_publications")) {
    const executingKeys = new Set<string>();
    for (const effect of listActiveExecutionApprovalEffectsForAgent(database, input.agentId)) {
      if (effect.state !== "executing") continue;
      const identity = effectPublicationIdentity(effect);
      if (identity && identity.roomId === input.roomId) {
        executingKeys.add(publicationIdentityKey(identity));
      }
    }
    if (executingKeys.size === 0) {
      database.prepare(`
        UPDATE execution_approval_publications
        SET state = 'invalid'
        WHERE agent_id = ? AND room_id = ?
          AND state IN ('open', 'attempted', 'acknowledged', 'closing')
      `).run(input.agentId, input.roomId);
    } else {
      const pendingPublications = database.prepare(`
        SELECT delegation_instance_id, delegation_revision, request_id, request_version
        FROM execution_approval_publications
        WHERE agent_id = ? AND room_id = ?
          AND state IN ('open', 'attempted', 'acknowledged', 'closing')
      `).all(input.agentId, input.roomId) as Array<Record<string, unknown>>;
      const updateOne = database.prepare(`
        UPDATE execution_approval_publications
        SET state = 'invalid'
        WHERE agent_id = ? AND room_id = ?
          AND delegation_instance_id = ? AND delegation_revision = ?
          AND request_id = ? AND request_version = ?
          AND state IN ('open', 'attempted', 'acknowledged', 'closing')
      `);
      for (const row of pendingPublications) {
        const identity: ExecutionApprovalPublicationIdentity = {
          roomId: input.roomId,
          delegationInstanceId: String(row.delegation_instance_id),
          delegationRevision: Number(row.delegation_revision),
          requestId: String(row.request_id),
          requestVersion: Number(row.request_version),
        };
        if (executingKeys.has(publicationIdentityKey(identity))) continue;
        updateOne.run(
          input.agentId,
          identity.roomId,
          identity.delegationInstanceId,
          identity.delegationRevision,
          identity.requestId,
          identity.requestVersion,
        );
      }
    }
  }
  if (preparedRows.length > 0) {
    pruneTerminalExecutionApprovalEffectsInTransaction(database, input.agentId);
  }
  return preparedRows.length;
}

/**
 * Retires `prepared` approval-publication effects and transitions pending
 * `execution_approval_publications` custody to terminal `invalid` for a fully
 * stopped agent inside the purge preparation/commit transaction before
 * `assertPurgePreconditions` runs. Genuinely active `executing` approval rows
 * and all non-approval blockers remain untouched so purge refuses and SQLite
 * rolls back every mutation atomically.
 */
export function retireExecutionApprovalEffectsForPurgeInTransaction(
  database: DatabaseSync,
  input: {
    agentId: string;
    expectedEpoch: number;
    nowIso?: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError(
      "retireExecutionApprovalEffectsForPurgeInTransaction requires an active fenced SQLite transaction.",
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
  const nowIso = input.nowIso ?? new Date().toISOString();
  const hasExecutingApproval = Boolean(database.prepare(`
    SELECT 1 FROM ${EFFECT_JOURNAL_TABLE}
    WHERE agent_id = ?
      AND kind IN (?, ?)
      AND state = 'executing'
    LIMIT 1
  `).get(input.agentId, EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND, EXECUTION_APPROVAL_CLOSE_EFFECT_KIND));
  const preparedRows = database.prepare(`
    SELECT id FROM ${EFFECT_JOURNAL_TABLE}
    WHERE agent_id = ?
      AND kind IN (?, ?)
      AND state = 'prepared'
    ORDER BY created_at ASC, id ASC
  `).all(
    input.agentId,
    EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
    EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
  ) as Array<{ id: string }>;
  for (const row of preparedRows) {
    failEffectInTransaction(database, {
      id: String(row.id),
      expectedEpoch: epoch,
      error: "agent_purged",
      nowIso,
    });
  }
  if (!hasExecutingApproval && hasTable(database, "execution_approval_publications")) {
    database.prepare(`
      UPDATE execution_approval_publications
      SET state = 'invalid'
      WHERE agent_id = ?
        AND state IN ('open', 'attempted', 'acknowledged', 'closing')
    `).run(input.agentId);
  }
  if (preparedRows.length > 0) {
    pruneTerminalExecutionApprovalEffectsInTransaction(database, input.agentId);
  }
  return preparedRows.length;
}

/**
 * Atomically retires specific durably obsolete `prepared` approval-publication
 * effects for `agentId` under the daemon write fence and bounds retained
 * terminal rows. Rows that already transitioned out of `prepared` are skipped
 * safely, while future-epoch rows fail closed. Items marked
 * `requireNoPendingRoomMove` are skipped atomically inside the transaction if
 * a non-terminal room move exists for `agentId` so compensatable moves never
 * drop source-room retries.
 */
export function retireObsoleteExecutionApprovalEffects(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    agentId: string;
    expectedEpoch: number;
    retirements: ReadonlyArray<{
      id: string;
      error: string;
      requireNoPendingRoomMove?: boolean;
      invalidatePublication?: ExecutionApprovalPublicationIdentity;
    }>;
    nowIso?: string;
  },
): string[] {
  if (input.retirements.length === 0) return [];
  const epoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const nowIso = input.nowIso ?? new Date().toISOString();
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    const needsRoomMoveCheck = input.retirements.some((item) => item.requireNoPendingRoomMove);
    const hasPendingRoomMove = needsRoomMoveCheck
      ? hasPendingRoomMoveForAgent(database, input.agentId)
      : false;
    const retiredIds: string[] = [];
    const publicationsToInvalidate: ExecutionApprovalPublicationIdentity[] = [];
    for (const item of input.retirements) {
      if (item.requireNoPendingRoomMove && hasPendingRoomMove) continue;
      const current = getEffect(database, item.id);
      if (!current || current.agent_id !== input.agentId) continue;
      if (current.kind !== EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND
        && current.kind !== EXECUTION_APPROVAL_CLOSE_EFFECT_KIND) continue;
      if (current.state !== "prepared") continue;
      failEffectInTransaction(database, {
        id: current.id,
        expectedEpoch: epoch,
        error: item.error,
        nowIso,
      });
      retiredIds.push(current.id);
      if (item.invalidatePublication) {
        publicationsToInvalidate.push(item.invalidatePublication);
      }
    }
    if (publicationsToInvalidate.length > 0 && hasTable(database, "execution_approval_publications")) {
      const executingKeys = new Set<string>();
      for (const effect of listActiveExecutionApprovalEffectsForAgent(database, input.agentId)) {
        if (effect.state !== "executing") continue;
        const identity = effectPublicationIdentity(effect);
        if (identity) executingKeys.add(publicationIdentityKey(identity));
      }
      const updateOne = database.prepare(`
        UPDATE execution_approval_publications
        SET state = 'invalid'
        WHERE agent_id = ? AND room_id = ?
          AND delegation_instance_id = ? AND delegation_revision = ?
          AND request_id = ? AND request_version = ?
          AND state IN ('open', 'attempted', 'acknowledged', 'closing')
      `);
      for (const identity of publicationsToInvalidate) {
        if (executingKeys.has(publicationIdentityKey(identity))) continue;
        updateOne.run(
          input.agentId,
          identity.roomId,
          identity.delegationInstanceId,
          identity.delegationRevision,
          identity.requestId,
          identity.requestVersion,
        );
      }
    }
    if (retiredIds.length > 0) {
      pruneTerminalExecutionApprovalEffectsInTransaction(database, input.agentId);
    }
    return retiredIds;
  });
}
