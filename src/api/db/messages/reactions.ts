import { and, asc, between, eq, inArray, lte, sql } from "drizzle-orm";

import {
  MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE,
  MESSAGE_REACTION_MAX_PER_READ,
  MESSAGE_REACTION_MAX_REACTORS_LISTED,
  type MessageReaction,
} from "../../../../shared/message-reactions.mjs";
import { db } from "../client.js";
import { accounts, message_reactions, messages } from "../schema.js";
import { visibleMessageCondition } from "./visibility.js";

type ReactionReader = Pick<typeof db, "select">;

export type MessageReactionScope =
  | { numbers: readonly number[] }
  | { first: number; last: number };

export interface MessageReactionRead {
  /** Keyed by message number; only messages with a reaction appear. */
  reactions: Map<number, MessageReaction[]>;
  /**
   * Null when the whole scope was read. Otherwise a range read stopped early:
   * it is complete below this message number, and continues from it.
   */
  nextFirst: number | null;
}

/**
 * Reactions for a set of messages in one bounded read: each emoji with its
 * exact count and its earliest reactors. A range read stops at
 * MESSAGE_REACTION_MAX_PER_READ rows, never returns half a message, and says
 * where to continue.
 */
export async function loadMessageReactions(
  executor: ReactionReader,
  roomId: string,
  scope: MessageReactionScope,
): Promise<MessageReactionRead> {
  const reactions = new Map<number, MessageReaction[]>();
  const explicit = "numbers" in scope;
  if (explicit ? scope.numbers.length === 0 : scope.last < scope.first) {
    return { reactions, nextFirst: null };
  }

  const perEmoji = sql`PARTITION BY ${message_reactions.message_number}, ${message_reactions.emoji}`;
  const ranked = executor
    .select({
      message_number: message_reactions.message_number,
      emoji: message_reactions.emoji,
      account_id: message_reactions.account_id,
      reactor_count: sql<number>`(count(*) OVER (${perEmoji}))::int`.as("reactor_count"),
      first_reacted_at: sql<string>`min(${message_reactions.created_at}) OVER (${perEmoji})`.as("first_reacted_at"),
      position: sql<number>`(row_number() OVER (${perEmoji} ORDER BY ${message_reactions.created_at}, ${message_reactions.account_id}))::int`.as("position"),
    })
    .from(message_reactions)
    .where(and(
      eq(message_reactions.room_id, roomId),
      explicit
        ? inArray(message_reactions.message_number, [...scope.numbers])
        : between(message_reactions.message_number, scope.first, scope.last),
    ))
    .as("ranked");

  const query = executor
    .select({
      message_number: ranked.message_number,
      emoji: ranked.emoji,
      reactor_count: ranked.reactor_count,
      login: accounts.login,
      display_name: accounts.display_name,
      avatar_url: accounts.avatar_url,
    })
    .from(ranked)
    .innerJoin(accounts, eq(accounts.id, ranked.account_id))
    .where(lte(ranked.position, MESSAGE_REACTION_MAX_REACTORS_LISTED))
    .orderBy(asc(ranked.message_number), asc(ranked.first_reacted_at), asc(ranked.emoji), asc(ranked.position));
  // A page of history is already bounded by its message count; a range is not.
  const rows = explicit ? await query : await query.limit(MESSAGE_REACTION_MAX_PER_READ + 1);

  // Rows arrive in message order, so everything below the first message the
  // limit cut into is complete. One message alone stays under the limit
  // (MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE emoji, each with its listed
  // reactors), so a continued read always moves forward.
  const nextFirst = !explicit && rows.length > MESSAGE_REACTION_MAX_PER_READ
    ? rows[MESSAGE_REACTION_MAX_PER_READ]!.message_number
    : null;
  for (const row of rows) {
    if (nextFirst !== null && row.message_number >= nextFirst) break;
    const list = reactions.get(row.message_number) ?? [];
    let reaction = list.at(-1);
    if (!reaction || reaction.emoji !== row.emoji) {
      reaction = { emoji: row.emoji, count: row.reactor_count, reactors: [] };
      list.push(reaction);
      reactions.set(row.message_number, list);
    }
    reaction.reactors.push({
      login: row.login,
      name: row.display_name?.trim() || row.login,
      avatar_url: row.avatar_url || null,
    });
  }
  return { reactions, nextFirst };
}

/** The emoji one person reacted with, per message number, in a range of messages. */
export async function loadViewerMessageReactions(
  executor: ReactionReader,
  roomId: string,
  accountId: string,
  range: { first: number; last: number },
): Promise<Map<number, string[]>> {
  const mine = new Map<number, string[]>();
  if (range.last < range.first) return mine;
  const rows = await executor
    .select({ message_number: message_reactions.message_number, emoji: message_reactions.emoji })
    .from(message_reactions)
    .where(and(
      eq(message_reactions.room_id, roomId),
      between(message_reactions.message_number, range.first, range.last),
      eq(message_reactions.account_id, accountId),
    ))
    .orderBy(asc(message_reactions.message_number), asc(message_reactions.created_at), asc(message_reactions.emoji));
  for (const row of rows) mine.set(row.message_number, [...(mine.get(row.message_number) ?? []), row.emoji]);
  return mine;
}

export async function getMessageReactions(roomId: string, messageNumber: number): Promise<MessageReaction[]> {
  const { reactions } = await loadMessageReactions(db, roomId, { numbers: [messageNumber] });
  return reactions.get(messageNumber) ?? [];
}

export type AddMessageReactionResult = "added" | "exists" | "message_not_found" | "limit_reached";

export async function addMessageReaction(input: {
  roomId: string;
  messageNumber: number;
  accountId: string;
  emoji: string;
}): Promise<AddMessageReactionResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    // One writer per message at a time, so the distinct-emoji limit holds.
    // NO KEY UPDATE leaves the message's other child rows writable.
    const [message] = await tx
      .select({ number: messages.number })
      .from(messages)
      .where(and(
        eq(messages.room_id, input.roomId),
        eq(messages.number, input.messageNumber),
        visibleMessageCondition(),
      ))
      .for("no key update");
    if (!message) return "message_not_found";

    const used = await tx
      .selectDistinct({ emoji: message_reactions.emoji })
      .from(message_reactions)
      .where(and(
        eq(message_reactions.room_id, input.roomId),
        eq(message_reactions.message_number, input.messageNumber),
      ));
    if (
      used.length >= MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE
      && !used.some((row) => row.emoji === input.emoji)
    ) return "limit_reached";

    const inserted = await tx
      .insert(message_reactions)
      .values({
        room_id: input.roomId,
        message_number: input.messageNumber,
        account_id: input.accountId,
        emoji: input.emoji,
      })
      .onConflictDoNothing()
      .returning({ emoji: message_reactions.emoji });
    return inserted.length > 0 ? "added" : "exists";
  });
}

/** True when the reaction existed and is now gone. */
export async function removeMessageReaction(input: {
  roomId: string;
  messageNumber: number;
  accountId: string;
  emoji: string;
}): Promise<boolean> {
  const removed = await db
    .delete(message_reactions)
    .where(and(
      eq(message_reactions.room_id, input.roomId),
      eq(message_reactions.message_number, input.messageNumber),
      eq(message_reactions.account_id, input.accountId),
      eq(message_reactions.emoji, input.emoji),
    ))
    .returning({ emoji: message_reactions.emoji });
  return removed.length > 0;
}
