import { sql } from "drizzle-orm";

import { db } from "../../client.js";
import { message_agent_receipts, room_agent_sessions } from "../../schema.js";
import type { MessageRecipientAgentTarget } from "../../types.js";
import {
  MAX_ACCOUNT_ROUTING_TARGET_BYTES,
  MAX_ACCOUNT_ROUTING_TARGETS,
} from "../account-agent-routing.js";

const MAX_BRIDGE_MESSAGE_RECIPIENTS = MAX_ACCOUNT_ROUTING_TARGETS;

/** Exact prompt audience used only for cross-instance reference hydration. */
export async function getMessageRecipientAgentTargets(
  roomId: string,
  messageNumber: number,
): Promise<MessageRecipientAgentTarget[]> {
  const rows = (await db.execute<{
    agent_key: string;
    agent_session_id: string;
    owner_account_id: string;
    successor_agent_session_id: string | null;
  }>(sql`
    WITH owned_receipt AS (
      SELECT receipt.agent_key,
             receipt.agent_session_id,
             captured.owner_account_id,
             captured.ended_at
        FROM ${message_agent_receipts} AS receipt
        JOIN ${room_agent_sessions} AS captured
          ON captured.room_id = receipt.room_id
         AND captured.session_id = receipt.agent_session_id
         AND captured.agent_key = receipt.agent_key
       WHERE receipt.message_room_id = ${roomId}
         AND receipt.message_number = ${messageNumber}
         AND captured.session_kind = 'worker'
    ), unique_live_successor AS (
      SELECT owned_receipt.owner_account_id,
             owned_receipt.agent_key,
             CASE WHEN COUNT(active.session_id) = 1
                    AND MIN(active.owner_account_id) = owned_receipt.owner_account_id
                    AND MAX(active.owner_account_id) = owned_receipt.owner_account_id
                    THEN MIN(active.session_id)
                  ELSE NULL END AS agent_session_id
        FROM owned_receipt
        LEFT JOIN ${room_agent_sessions} AS active
          ON active.room_id = ${roomId}
         AND active.agent_key = owned_receipt.agent_key
         AND active.session_kind = 'worker'
         AND active.ended_at IS NULL
       WHERE owned_receipt.ended_at IS NOT NULL
       GROUP BY owned_receipt.owner_account_id, owned_receipt.agent_key
    )
    SELECT owned_receipt.agent_key,
           owned_receipt.agent_session_id,
           owned_receipt.owner_account_id,
           CASE WHEN owned_receipt.ended_at IS NOT NULL
                  THEN unique_live_successor.agent_session_id
                ELSE NULL END AS successor_agent_session_id
      FROM owned_receipt
      LEFT JOIN unique_live_successor
        ON unique_live_successor.owner_account_id = owned_receipt.owner_account_id
       AND unique_live_successor.agent_key = owned_receipt.agent_key
     LIMIT ${MAX_BRIDGE_MESSAGE_RECIPIENTS + 1}
  `)).rows;
  if (rows.length > MAX_BRIDGE_MESSAGE_RECIPIENTS) {
    throw new Error("message recipient set exceeds the bridge hydration limit");
  }
  let bytes = 0;
  const result: MessageRecipientAgentTarget[] = [];
  for (const row of rows) {
    const target = {
      agent_key: row.agent_key,
      agent_session_id: row.agent_session_id,
      owner_account_id: row.owner_account_id,
      ...(row.successor_agent_session_id
        ? { successor_agent_session_id: row.successor_agent_session_id }
        : {}),
    };
    bytes += Buffer.byteLength(JSON.stringify(target), "utf8");
    if (bytes > MAX_ACCOUNT_ROUTING_TARGET_BYTES) {
      throw new Error("message recipient set exceeds the bridge hydration byte limit");
    }
    result.push(target);
  }
  return result;
}

/** Compatibility helper for diagnostics that need only durable keys. */
export async function getMessageRecipientAgentKeys(
  roomId: string,
  messageNumber: number,
): Promise<string[]> {
  return (await getMessageRecipientAgentTargets(roomId, messageNumber))
    .map((target) => target.agent_key);
}
