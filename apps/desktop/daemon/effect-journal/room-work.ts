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
  listEffectsForAgent,
  pruneTerminalEffectsByKindsInTransaction,
} from "./store.js";
import type { EffectRecord } from "./types.js";

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
