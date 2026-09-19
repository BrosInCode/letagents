import { sql } from "drizzle-orm";

import { db } from "../client.js";
import { message_agent_receipts, messages } from "../schema.js";
import type { Message, MessageRow } from "../types.js";
import { hydrateMessageReplies } from "./history.js";

const CATCH_UP_LIMIT = 25;
/** Receipts older than this are the stall watchdog's problem, not a poll page's. */
const CATCH_UP_WINDOW = "30 minutes";

/**
 * Messages at or before a worker's poll cursor whose receipt for that worker
 * was appended after the message committed (deferred conversation routing)
 * and has not been handed to the worker yet. A long-poll that was between
 * requests when the routing event fired can only learn of such a receipt
 * from its next page, so this claims each one exactly once.
 */
export async function claimDeferredRoutingCatchUp(
  roomId: string,
  agentKey: string,
  cursorNumber: number,
): Promise<Message[]> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<Record<string, unknown>>(sql`
      WITH candidates AS (
        SELECT r.id AS receipt_id, m.*
          FROM ${message_agent_receipts} AS r
          JOIN ${messages} AS m
            ON m.room_id = r.message_room_id AND m.number = r.message_number
         WHERE r.message_room_id = ${roomId}
           AND r.agent_key = ${agentKey}
           AND r.receipt_state = 'queued'
           AND r.deferred_delivered_at IS NULL
           AND r.created_at > m.timestamp + INTERVAL '1 second'
           AND r.created_at > NOW() - INTERVAL '${sql.raw(CATCH_UP_WINDOW)}'
           AND m.number <= ${cursorNumber}
         ORDER BY m.number
         LIMIT ${CATCH_UP_LIMIT}
         FOR UPDATE OF r SKIP LOCKED
      ), delivered AS (
        UPDATE ${message_agent_receipts} AS r
           SET deferred_delivered_at = NOW()
          FROM candidates
         WHERE r.id = candidates.receipt_id
         RETURNING r.id
      )
      SELECT candidates.* FROM candidates ORDER BY candidates.number
    `);
    if (claimed.rows.length === 0) return [];
    const rows = claimed.rows.map(({ receipt_id: _receiptId, ...row }) => row as unknown as MessageRow);
    return hydrateMessageReplies(roomId, rows, { accountId: null, executor: tx });
  });
}
