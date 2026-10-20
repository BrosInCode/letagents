/** Writes queued agent receipts for a message in bounded, set-based batches. */
import { sql } from "drizzle-orm";
import { message_agent_receipts } from "../../schema.js";
import type { ReplyTurnFields } from "../reply-turns.js";
import type { MessageCreateTransaction } from "./types.js";

const MESSAGE_RECEIPT_INSERT_BATCH_SIZE = 500;

export function chunkMessageReceiptRows<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += MESSAGE_RECEIPT_INSERT_BATCH_SIZE) {
    chunks.push(rows.slice(offset, offset + MESSAGE_RECEIPT_INSERT_BATCH_SIZE));
  }
  return chunks;
}
export async function insertMessageReceiptRows(
  tx: MessageCreateTransaction,
  rows: readonly ({
    id: string;
    message_room_id: string;
    message_number: number;
    room_id: string;
    agent_session_id: string;
    agent_key: string;
    actor_label: string;
    activation_reason: string;
    receipt_state: string;
    created_at: string;
    updated_at: string;
  } & Partial<ReplyTurnFields>)[],
): Promise<void> {
  for (const batch of chunkMessageReceiptRows(rows)) {
    // One JSON bind per bounded batch avoids Drizzle/Postgres parameter growth
    // and keeps large broadcasts set-based inside the message transaction.
    await tx.execute(sql`
      INSERT INTO ${message_agent_receipts} (
        id, message_room_id, message_number, room_id, agent_session_id,
        agent_key, actor_label, activation_reason, receipt_state,
        turn_position, turn_count, hold_release_after, hold_released_at,
        created_at, updated_at
      )
      SELECT input.id, input.message_room_id, input.message_number,
             input.room_id, input.agent_session_id, input.agent_key,
             input.actor_label, input.activation_reason, input.receipt_state,
             input.turn_position, input.turn_count,
             input.hold_release_after::timestamptz, input.hold_released_at::timestamptz,
             input.created_at::timestamptz, input.updated_at::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS input(
          id text, message_room_id text, message_number integer, room_id text,
          agent_session_id text, agent_key text, actor_label text,
          activation_reason text, receipt_state text,
          turn_position integer, turn_count integer,
          hold_release_after text, hold_released_at text,
          created_at text, updated_at text
        )
      ON CONFLICT DO NOTHING
    `);
  }
}
