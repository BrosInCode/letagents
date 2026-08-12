import { sql } from "drizzle-orm";

import { db } from "../client.js";
import { messages } from "../schema.js";
import { formatMessageId, parseScopedId } from "../utils.js";
import { visibleMessageCondition } from "./visibility.js";

/** One body-free, index-bounded query for the SSE snapshot/subscribe barrier. */
export async function getMessageStreamCheckpoint(
  roomId: string,
  options: { requestedCursor?: string | null; includePromptOnly?: boolean },
): Promise<{ checkpoint: string | null; cursorExists: boolean }> {
  const requestedNumber = options.requestedCursor
    ? parseScopedId(options.requestedCursor, "msg")
    : null;
  const visible = visibleMessageCondition(options.includePromptOnly);
  const result = await db.execute<{
    checkpoint_number: number | null;
    cursor_exists: boolean;
  }>(sql`
    SELECT
      (
        SELECT ${messages.number}
        FROM ${messages}
        WHERE ${messages.room_id} = ${roomId} AND ${visible}
        ORDER BY ${messages.number} DESC
        LIMIT 1
      ) AS checkpoint_number,
      ${requestedNumber
        ? sql`EXISTS (
            SELECT 1
            FROM ${messages}
            WHERE ${messages.room_id} = ${roomId}
              AND ${messages.number} = ${requestedNumber}
              AND ${visible}
          )`
        : sql`TRUE`} AS cursor_exists
  `);
  const row = result.rows[0];
  const checkpointNumber = Number(row?.checkpoint_number);
  return {
    checkpoint: Number.isSafeInteger(checkpointNumber) && checkpointNumber > 0
      ? formatMessageId(checkpointNumber)
      : null,
    cursorExists: row?.cursor_exists === true,
  };
}
