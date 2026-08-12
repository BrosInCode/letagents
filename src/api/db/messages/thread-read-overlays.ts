import { and, eq, sql } from "drizzle-orm";

import { RequestValidationError } from "../../validation-error.js";
import { db } from "../client.js";
import { message_thread_reads } from "../schema.js";
import { formatMessageId, parseScopedId } from "../utils.js";

export interface MessageThreadReadTarget {
  root_message_id: string;
  reply_count: number;
}

export interface MessageThreadReadOverlay {
  last_read_message_id: string | null;
  unread_count: number;
  has_unread: boolean;
}

export const MAX_THREAD_READ_OVERLAY_TARGETS = 1_000;
export const MAX_THREAD_READ_OVERLAY_PAIRS = 100_000;

/**
 * Resolve only the account-specific portion of already-hydrated thread
 * summaries. Event brokers can batch every subscriber account into one small
 * cursor query, then reuse the canonical message/attachment/participant data.
 */
export async function getMessageThreadReadOverlays(
  roomId: string,
  targets: readonly MessageThreadReadTarget[],
  accountIds: readonly string[],
): Promise<Map<string, Map<string, MessageThreadReadOverlay>>> {
  const targetByNumber = new Map<number, MessageThreadReadTarget>();
  for (const target of targets) {
    const rootNumber = parseScopedId(target.root_message_id, "msg");
    if (!rootNumber) continue;
    const current = targetByNumber.get(rootNumber);
    if (!current || Number(target.reply_count) > Number(current.reply_count)) {
      targetByNumber.set(rootNumber, target);
    }
  }
  const uniqueAccountIds = Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
  const overlays = new Map<string, Map<string, MessageThreadReadOverlay>>();
  if (targetByNumber.size === 0 || uniqueAccountIds.length === 0) return overlays;
  if (targetByNumber.size > MAX_THREAD_READ_OVERLAY_TARGETS) {
    throw new RequestValidationError(
      `thread read overlay request exceeds ${MAX_THREAD_READ_OVERLAY_TARGETS} threads; split the broker batch`,
    );
  }
  if (targetByNumber.size * uniqueAccountIds.length > MAX_THREAD_READ_OVERLAY_PAIRS) {
    throw new RequestValidationError(
      `thread read overlay request exceeds ${MAX_THREAD_READ_OVERLAY_PAIRS} account/thread pairs; split the broker batch`,
    );
  }

  const rows = await db
    .select({
      account_id: message_thread_reads.account_id,
      thread_root_number: message_thread_reads.thread_root_number,
      last_read_message_number: message_thread_reads.last_read_message_number,
      last_read_reply_count: message_thread_reads.last_read_reply_count,
    })
    .from(message_thread_reads)
    .where(and(
      eq(message_thread_reads.room_id, roomId),
      sql`${message_thread_reads.thread_root_number} IN (
        SELECT value::integer
          FROM jsonb_array_elements_text(${JSON.stringify(Array.from(targetByNumber.keys()))}::jsonb)
      )`,
      sql`${message_thread_reads.account_id} IN (
        SELECT value
          FROM jsonb_array_elements_text(${JSON.stringify(uniqueAccountIds)}::jsonb)
      )`,
    ));
  const reads = new Map(rows.map((row) => [`${row.account_id}\0${row.thread_root_number}`, row]));

  for (const accountId of uniqueAccountIds) {
    const accountOverlays = new Map<string, MessageThreadReadOverlay>();
    for (const [rootNumber, target] of targetByNumber) {
      const read = reads.get(`${accountId}\0${rootNumber}`);
      const replyCount = Math.max(0, Number(target.reply_count) || 0);
      const unreadCount = Math.max(0, replyCount - (Number(read?.last_read_reply_count) || 0));
      accountOverlays.set(target.root_message_id, {
        last_read_message_id: read?.last_read_message_number
          ? formatMessageId(read.last_read_message_number)
          : null,
        unread_count: unreadCount,
        has_unread: unreadCount > 0,
      });
    }
    overlays.set(accountId, accountOverlays);
  }

  return overlays;
}
