import { and, desc, eq, sql } from "drizzle-orm";
import { MESSAGE_PIN_LIMIT, messagePinSnippet, type MessagePin } from "../../../../shared/message-pins.mjs";
import { db } from "../client.js";
import { accounts, message_pins, messages } from "../schema.js";
import { formatMessageId } from "../utils.js";
import { visibleMessageCondition } from "./visibility.js";

// A two-int advisory-lock namespace reserved for pins ("PINS"). This does not
// lock rooms or id_sequences, so message sends never wait on the pin count.
export const MESSAGE_PINS_LOCK_NAMESPACE = 0x50494e53;

export async function getMessagePins(roomId: string): Promise<MessagePin[]> {
  const rows = await db.select({
    number: messages.number,
    sender: messages.sender,
    source: messages.source,
    timestamp: messages.timestamp,
    threadRoot: messages.thread_root_number,
    text: messages.text,
    displayText: messages.display_text,
    pinnedAt: message_pins.pinned_at,
    login: accounts.login,
    name: accounts.display_name,
    avatar: accounts.avatar_url,
  }).from(message_pins)
    .innerJoin(messages, and(eq(messages.room_id, message_pins.room_id), eq(messages.number, message_pins.message_number)))
    .innerJoin(accounts, eq(accounts.id, message_pins.pinned_by_account_id))
    .where(and(eq(message_pins.room_id, roomId), visibleMessageCondition()))
    .orderBy(desc(message_pins.pinned_at), desc(message_pins.message_number))
    .limit(MESSAGE_PIN_LIMIT);
  return rows.map((row) => ({
    message_id: formatMessageId(row.number),
    sender: row.sender,
    source: row.source,
    timestamp: row.timestamp,
    thread_root_id: row.threadRoot === null ? null : formatMessageId(row.threadRoot),
    snippet: messagePinSnippet(row.text, row.displayText),
    pinned_at: row.pinnedAt,
    pinned_by: { login: row.login, name: row.name?.trim() || row.login, avatar_url: row.avatar || null },
  }));
}

export type SetMessagePinResult = "changed" | "unchanged" | "message_not_found" | "pin_limit";

export async function setMessagePin(input: {
  roomId: string; messageNumber: number; accountId: string; pinned: boolean;
}): Promise<SetMessagePinResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${MESSAGE_PINS_LOCK_NAMESPACE}::int, hashtext(${input.roomId}))`);
    const target = and(eq(message_pins.room_id, input.roomId), eq(message_pins.message_number, input.messageNumber));
    if (!input.pinned) {
      // Also permits cleanup of an already-hidden pin; no message is disclosed.
      const removed = await tx.delete(message_pins).where(target).returning({ number: message_pins.message_number });
      return removed.length ? "changed" : "unchanged";
    }
    const [message] = await tx.select({ number: messages.number }).from(messages)
      .where(and(eq(messages.room_id, input.roomId), eq(messages.number, input.messageNumber), visibleMessageCondition()))
      .for("no key update");
    if (!message) return "message_not_found";
    const [existing] = await tx.select({ number: message_pins.message_number }).from(message_pins).where(target);
    if (existing) return "unchanged";
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(message_pins)
      .where(eq(message_pins.room_id, input.roomId));
    if (count!.total >= MESSAGE_PIN_LIMIT) return "pin_limit";
    await tx.insert(message_pins).values({
      room_id: input.roomId, message_number: input.messageNumber, pinned_by_account_id: input.accountId,
    });
    return "changed";
  });
}
