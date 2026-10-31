import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";

import {
  MESSAGE_SEARCH_DEFAULT_LIMIT,
  MESSAGE_SEARCH_MAX_LIMIT,
} from "../../../../shared/message-search.mjs";
import { db } from "../client.js";
import { messages } from "../schema.js";
import type { Message } from "../types.js";
import { clampLimit, formatMessageId } from "../utils.js";
import { hydrateMessageReplies } from "./history.js";
import { messageRowSelection } from "./selections.js";
import { visibleMessageCondition } from "./visibility.js";

// Search additionally hides auto prompts blank under JavaScript trim. Keep
// this local: shared history visibility must match the one-argument BTRIM
// in the materialized thread-summary triggers (migration 0078).
const messageWhitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** A term as a LIKE pattern that matches it anywhere, with its own wildcards made literal. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export interface MessageSearchPage {
  /** Newest first. */
  messages: Message[];
  has_more: boolean;
  next_before: string | null;
}

/**
 * Messages in one room that contain every term, newest first. Matching reads
 * the text people see: the message text, and the readable copy a system
 * message carries. Empty prompt-only messages are never found.
 *
 * The scan is bounded by the room and by a statement timeout rather than by an
 * index, so the caller must expect PostgreSQL error 57014 on a pathological room.
 */
export async function searchRoomMessages(
  roomId: string,
  terms: readonly string[],
  options: { before?: number | null; limit?: number; accountId?: string | null } = {},
): Promise<MessageSearchPage> {
  if (terms.length === 0) return { messages: [], has_more: false, next_before: null };
  const limit = clampLimit(options.limit, MESSAGE_SEARCH_DEFAULT_LIMIT, MESSAGE_SEARCH_MAX_LIMIT);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '4s'`);
    const rows = await tx
      .select(messageRowSelection)
      .from(messages)
      .where(and(
        eq(messages.room_id, roomId),
        options.before ? lt(messages.number, options.before) : undefined,
        visibleMessageCondition(),
        sql`(${messages.agent_prompt_kind} IS NULL OR ${messages.agent_prompt_kind} <> 'auto' OR BTRIM(${messages.text}, ${messageWhitespace}) <> '')`,
        ...terms.map((term) => {
          const pattern = containsPattern(term);
          return or(ilike(messages.text, pattern), ilike(messages.display_text, pattern));
        }),
      ))
      .orderBy(desc(messages.number))
      .limit(limit + 1);

    const has_more = rows.length > limit;
    const page = has_more ? rows.slice(0, limit) : rows;
    return {
      messages: await hydrateMessageReplies(roomId, page, { accountId: options.accountId ?? null, executor: tx }),
      has_more,
      next_before: has_more ? formatMessageId(page.at(-1)!.number) : null,
    };
  });
}
