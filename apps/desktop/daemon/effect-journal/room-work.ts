/**
 * Room-work publication outbound effect descriptors, idempotency keys, and
 * bounded terminal retention on the unified `effects` journal.
 *
 * Immutable provenance, monotonic revisions, SHA-256 digests, and review-page
 * blobs remain in `room_work_publications` / `room_workspace_*` (and grouped
 * peer receipts remain in `supervised_agent_inbox_events`). The `effects` table
 * owns outbound dispatch durability, retry backoff (`next_attempt_at_ms`),
 * startup crash recovery, duplicate suppression, and handoff fencing/drain.
 *
 * No bearer token, supervisor grant, raw provider error, or review-page bytes
 * ever enter `effects.payload`, `effects.outcome`, or `effects.last_error`.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { EFFECT_JOURNAL_TABLE } from "./schema.js";
import {
  failEffectInTransaction,
  getEffect,
  listEffectsForAgent,
  prepareEffectInTransaction,
  pruneTerminalEffectsByKindsInTransaction,
  withFencedEffectTransaction,
} from "./store.js";
import {
  assertPositiveEpoch,
  EffectFenceError,
  type EffectRecord,
  type PrepareEffectInput,
  type PrepareEffectResult,
} from "./types.js";

export const ROOM_WORK_PUBLISH_EFFECT_KIND = "room_work_publish" as const;
export const ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND = "room_work_grouped_no_reply" as const;
export const ROOM_WORK_EFFECT_KINDS = [
  ROOM_WORK_PUBLISH_EFFECT_KIND,
  ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND,
] as const;

/**
 * High positive safe cap so offline desktops keep retrying optional room-work
 * uploads every 30s without permanently failing a staged revision after a few
 * minutes of network outage.
 */
export const ROOM_WORK_EFFECT_MAX_ATTEMPTS = 1_000_000;

/** Bound terminal (`completed` / `failed`) room-work rows retained per agent in `effects`. */
export const ROOM_WORK_RETAINED_TERMINAL_EFFECTS_PER_AGENT = 512;

export type RoomWorkPublishEffectPayload = {
  room_id: string;
  source_message_id: string;
  attempt_id: string;
  revision: number;
  digest: string;
  review_page_index: number | null;
  review_page_total: number | null;
  review_page_digest: string | null;
};

export type RoomWorkGroupedNoReplyEffectPayload = {
  room_id: string;
  source_message_id: string;
  inbox_item_id: string;
};

export function roomWorkPublishIdempotencyKey(input: {
  roomId: string;
  sourceMessageId: string;
  revision: number;
  digest: string;
  reviewPageIndex?: number | null;
  reviewPageDigest?: string | null;
}): string {
  const hash = createHash("sha256").update(JSON.stringify([
    input.roomId,
    input.sourceMessageId,
    input.revision,
    input.digest,
    input.reviewPageIndex ?? null,
    input.reviewPageDigest ?? null,
  ])).digest("hex");
  return `rw:v1:${hash}`;
}

export function roomWorkGroupedNoReplyIdempotencyKey(input: {
  roomId: string;
  sourceMessageId: string;
  inboxItemId: string;
}): string {
  const hash = createHash("sha256").update(JSON.stringify([
    input.roomId,
    input.sourceMessageId,
    input.inboxItemId,
  ])).digest("hex");
  return `rwg:v1:${hash}`;
}

export function parseRoomWorkPublishEffectPayload(payload: unknown): RoomWorkPublishEffectPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (typeof raw.room_id !== "string" || !raw.room_id
    || typeof raw.source_message_id !== "string" || !raw.source_message_id
    || typeof raw.attempt_id !== "string" || !raw.attempt_id
    || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
    || typeof raw.digest !== "string" || !/^[0-9a-f]{64}$/.test(raw.digest)) {
    return null;
  }
  const hasPage = raw.review_page_index !== null && raw.review_page_index !== undefined;
  if (hasPage) {
    if (!Number.isSafeInteger(raw.review_page_index) || Number(raw.review_page_index) < 0
      || !Number.isSafeInteger(raw.review_page_total) || Number(raw.review_page_total) < 1
      || typeof raw.review_page_digest !== "string" || !raw.review_page_digest) {
      return null;
    }
    return {
      room_id: raw.room_id,
      source_message_id: raw.source_message_id,
      attempt_id: raw.attempt_id,
      revision: Number(raw.revision),
      digest: raw.digest,
      review_page_index: Number(raw.review_page_index),
      review_page_total: Number(raw.review_page_total),
      review_page_digest: raw.review_page_digest,
    };
  }
  if (raw.review_page_total !== null && raw.review_page_total !== undefined) return null;
  if (raw.review_page_digest !== null && raw.review_page_digest !== undefined) return null;
  return {
    room_id: raw.room_id,
    source_message_id: raw.source_message_id,
    attempt_id: raw.attempt_id,
    revision: Number(raw.revision),
    digest: raw.digest,
    review_page_index: null,
    review_page_total: null,
    review_page_digest: null,
  };
}

export function parseRoomWorkGroupedNoReplyEffectPayload(payload: unknown): RoomWorkGroupedNoReplyEffectPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (typeof raw.room_id !== "string" || !raw.room_id
    || typeof raw.source_message_id !== "string" || !raw.source_message_id
    || typeof raw.inbox_item_id !== "string" || !raw.inbox_item_id) {
    return null;
  }
  return {
    room_id: raw.room_id,
    source_message_id: raw.source_message_id,
    inbox_item_id: raw.inbox_item_id,
  };
}

export function listActiveRoomWorkEffectsForAgent(
  database: DatabaseSync,
  agentId: string,
  kind: typeof ROOM_WORK_PUBLISH_EFFECT_KIND | typeof ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND,
): EffectRecord[] {
  return listEffectsForAgent(database, agentId, {
    kind,
    states: ["prepared", "executing"],
  });
}

export function hasInterruptedRoomWorkEffects(database: DatabaseSync): boolean {
  return Boolean(database.prepare(`
    SELECT 1 FROM ${EFFECT_JOURNAL_TABLE}
    WHERE kind IN (?, ?) AND state = 'executing'
    LIMIT 1
  `).get(ROOM_WORK_PUBLISH_EFFECT_KIND, ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND));
}

export function pruneTerminalRoomWorkEffectsInTransaction(
  database: DatabaseSync,
  agentId: string,
  maxRetained = ROOM_WORK_RETAINED_TERMINAL_EFFECTS_PER_AGENT,
): number {
  return pruneTerminalEffectsByKindsInTransaction(
    database,
    agentId,
    ROOM_WORK_EFFECT_KINDS,
    maxRetained,
  );
}

/**
 * Atomically retires superseded `prepared` room-work publish effects for a
 * source and admits a newly created replacement effect carrying the maximum
 * inherited retry deadline (`next_attempt_at_ms`) inside one fenced write
 * transaction. If a replacement row for that exact idempotency key already
 * exists, it is returned unchanged so immutable `prepared` rows are never
 * updated in place. If replacement admission fails for any reason, SQLite rolls
 * back the entire transaction so the superseded `prepared` row(s) and their
 * retry deadline remain intact.
 */
export function supersedeRoomWorkPublishEffects(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    staleEffectIds: readonly string[];
    replacement: Omit<PrepareEffectInput, "kind" | "retryable" | "max_attempts" | "next_attempt_at_ms"> & {
      payload: RoomWorkPublishEffectPayload;
    };
    nowIso?: string;
  },
): PrepareEffectResult {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const epoch = assertPositiveEpoch(input.replacement.epoch);
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    let inheritedRetryAtMs: number | null = null;
    for (const staleId of input.staleEffectIds) {
      const current = getEffect(database, staleId);
      if (!current) {
        throw new EffectFenceError(`Unknown superseded room-work effect ${staleId}.`);
      }
      if (current.idempotency_key === input.replacement.idempotency_key) continue;
      if (current.state !== "prepared") {
        throw new EffectFenceError(
          `Superseded room-work effect ${staleId} cannot be retired from state ${current.state}.`,
        );
      }
      if (current.epoch > epoch) {
        throw new EffectFenceError(
          `Stale daemon generation ${epoch} cannot supersede room-work effect ${staleId} owned by epoch ${current.epoch}.`,
        );
      }
      if (current.next_attempt_at_ms !== null) {
        inheritedRetryAtMs = inheritedRetryAtMs === null
          ? current.next_attempt_at_ms
          : Math.max(inheritedRetryAtMs, current.next_attempt_at_ms);
      }
      failEffectInTransaction(database, {
        id: staleId,
        expectedEpoch: epoch,
        error: "superseded_by_newer_revision",
        nowIso,
      });
    }

    return prepareEffectInTransaction(
      database,
      {
        ...input.replacement,
        kind: ROOM_WORK_PUBLISH_EFFECT_KIND,
        retryable: true,
        max_attempts: ROOM_WORK_EFFECT_MAX_ATTEMPTS,
        next_attempt_at_ms: inheritedRetryAtMs,
      },
      nowIso,
    );
  });
}

/**
 * Retires `prepared` room-work effects (`room_work_publish` and
 * `room_work_grouped_no_reply`) for `agentId` inside an active fenced SQLite
 * transaction. Never touches `executing` rows (so genuinely active in-flight
 * uploads remain protected) and fails closed on rows owned by a newer epoch.
 */
export function retireRoomWorkEffectsInTransaction(
  database: DatabaseSync,
  input: {
    agentId: string;
    expectedEpoch: number;
    error: string;
    roomId?: string;
    nowIso?: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError("retireRoomWorkEffectsInTransaction requires an active fenced SQLite transaction.");
  }
  const epoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const nowIso = input.nowIso ?? new Date().toISOString();
  const rows = (input.roomId !== undefined
    ? database.prepare(`
        SELECT id FROM ${EFFECT_JOURNAL_TABLE}
        WHERE agent_id = ?
          AND kind IN (?, ?)
          AND state = 'prepared'
          AND json_extract(payload, '$.room_id') = ?
        ORDER BY created_at ASC, id ASC
      `).all(input.agentId, ROOM_WORK_PUBLISH_EFFECT_KIND, ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND, input.roomId)
    : database.prepare(`
        SELECT id FROM ${EFFECT_JOURNAL_TABLE}
        WHERE agent_id = ?
          AND kind IN (?, ?)
          AND state = 'prepared'
        ORDER BY created_at ASC, id ASC
      `).all(input.agentId, ROOM_WORK_PUBLISH_EFFECT_KIND, ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND)) as Array<{ id: string }>;
  for (const row of rows) {
    failEffectInTransaction(database, {
      id: String(row.id),
      expectedEpoch: epoch,
      error: input.error,
      nowIso,
    });
  }
  if (rows.length > 0) {
    pruneTerminalRoomWorkEffectsInTransaction(database, input.agentId);
  }
  return rows.length;
}

/**
 * Retires `prepared` room-work effects for a fully stopped agent inside the
 * purge preparation/commit transaction before `assertPurgePreconditions` runs.
 * Genuinely active `executing` rows and all non-room-work effects remain
 * untouched and continue to block purge; if any purge precondition fails,
 * SQLite rolls back these retirements atomically.
 */
export function retireRoomWorkEffectsForPurgeInTransaction(
  database: DatabaseSync,
  input: {
    agentId: string;
    expectedEpoch: number;
    nowIso?: string;
  },
): number {
  if (!database.isTransaction) {
    throw new EffectFenceError("retireRoomWorkEffectsForPurgeInTransaction requires an active fenced SQLite transaction.");
  }
  const lifecycle = database.prepare("SELECT desired_state, observed_state FROM agents WHERE agent_id = ?")
    .get(input.agentId) as { desired_state?: string; observed_state?: string } | undefined;
  if (!lifecycle
    || lifecycle.desired_state !== "stopped"
    || !["absent", "stopped", "failed"].includes(String(lifecycle.observed_state))) {
    return 0;
  }
  return retireRoomWorkEffectsInTransaction(database, {
    agentId: input.agentId,
    expectedEpoch: input.expectedEpoch,
    error: "agent_purged",
    nowIso: input.nowIso,
  });
}

/**
 * Atomically retires specific durably obsolete `prepared` room-work effects for
 * `agentId` under the daemon write fence and bounds retained terminal rows.
 * Rows that already transitioned out of `prepared` are skipped safely, while
 * future-epoch rows fail closed.
 */
export function retireObsoleteRoomWorkEffects(
  database: DatabaseSync,
  assertWriteFence: () => void,
  input: {
    agentId: string;
    expectedEpoch: number;
    retirements: ReadonlyArray<{ id: string; error: string }>;
    nowIso?: string;
  },
): string[] {
  if (input.retirements.length === 0) return [];
  const epoch = assertPositiveEpoch(input.expectedEpoch, "expectedEpoch");
  const nowIso = input.nowIso ?? new Date().toISOString();
  return withFencedEffectTransaction(database, assertWriteFence, () => {
    const retiredIds: string[] = [];
    for (const item of input.retirements) {
      const current = getEffect(database, item.id);
      if (!current || current.agent_id !== input.agentId) continue;
      if (current.kind !== ROOM_WORK_PUBLISH_EFFECT_KIND && current.kind !== ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND) continue;
      if (current.state !== "prepared") continue;
      failEffectInTransaction(database, {
        id: current.id,
        expectedEpoch: epoch,
        error: item.error,
        nowIso,
      });
      retiredIds.push(current.id);
    }
    if (retiredIds.length > 0) {
      pruneTerminalRoomWorkEffectsInTransaction(database, input.agentId);
    }
    return retiredIds;
  });
}
