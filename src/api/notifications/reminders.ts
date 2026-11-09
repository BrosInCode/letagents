import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { message_reminders, messages, rooms } from "../db/schema.js";
import { visibleMessageCondition } from "../db/messages/visibility.js";
import { wakeJobQueue } from "../server/job-queue-wakes.js";

export const REMINDER_PENDING_LIMIT = 100;
export async function createMessageReminder(input: { accountId: string; roomId: string; messageNumber: number; dueAt: string }) {
  const created = await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1380798020, hashtext(${input.accountId}))`);
    const time = await tx.execute(sql`SELECT ${input.dueAt}::timestamptz > statement_timestamp() AND ${input.dueAt}::timestamptz <= statement_timestamp() + INTERVAL '30 days' AS valid`);
    if (!time.rows[0]?.valid) return { error: "invalid_due_at" } as const;
    const [message] = await tx.select({ number: messages.number }).from(messages)
      .where(and(eq(messages.room_id, input.roomId), eq(messages.number, input.messageNumber), visibleMessageCondition())).for("key share");
    if (!message) return { error: "message_not_found" } as const;
    const count = await tx.execute(sql`SELECT count(*)::int AS total FROM message_reminders WHERE account_id = ${input.accountId} AND state = 'pending'`);
    if (Number(count.rows[0]?.total) >= REMINDER_PENDING_LIMIT) return { error: "reminder_limit" } as const;
    const [reminder] = await tx.insert(message_reminders).values({ id: randomUUID(), account_id: input.accountId, room_id: input.roomId, message_number: input.messageNumber, due_at: input.dueAt }).returning();
    return { reminder: reminder! } as const;
  });
  // The push worker sleeps until its next due row; it must learn of this one.
  if ("reminder" in created) wakeJobQueue("desktop_push");
  return created;
}

export async function deleteMessageReminder(accountId: string, id: string): Promise<void> {
  // The row lock serializes cancellation with the atomic due claim. Cascades
  // remove queued/claimed deliveries; delivery rechecks existence after auth.
  await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.delete(message_reminders).where(and(eq(message_reminders.account_id, accountId), eq(message_reminders.id, id)));
  });
}

export async function listMessageReminders(accountId: string, offset: number) {
  return db.select().from(message_reminders).where(eq(message_reminders.account_id, accountId))
    .orderBy(message_reminders.due_at, message_reminders.id).limit(51).offset(offset);
}

export async function loadReminderMessage(roomId: string, messageNumber: number) {
  const [message] = await db.select({ sender: messages.sender, body: messages.text, displayText: messages.display_text,
    threadRoot: messages.thread_root_number, roomName: rooms.display_name }).from(messages)
    .innerJoin(rooms, eq(rooms.id, messages.room_id))
    .where(and(eq(messages.room_id, roomId), eq(messages.number, messageNumber), visibleMessageCondition()));
  return message ?? null;
}

/** Reminders one pass turns into deliveries at most. */
export const REMINDER_ENQUEUE_LIMIT = 50;

/**
 * One indexed, bounded claim per push-worker pass, atomic with device
 * enqueue. Returns how many reminders fell due (REMINDER_ENQUEUE_LIMIT means
 * more may wait).
 */
export async function enqueueDueReminders(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const result = await client.query<{ due: number }>(`
      WITH ready AS (
        SELECT id FROM message_reminders
        WHERE state = 'pending' AND due_at <= NOW()
        ORDER BY due_at, id FOR UPDATE SKIP LOCKED LIMIT ${REMINDER_ENQUEUE_LIMIT}
      ), due AS (
        UPDATE message_reminders AS reminder SET state = 'due'
        FROM ready WHERE reminder.id = ready.id RETURNING reminder.*
      ), enqueued AS (
        INSERT INTO desktop_reminder_deliveries (id, reminder_id, device_id, room_id, message_number)
        SELECT 'lr_' || md5(device.id || ':' || due.id), due.id, device.id, due.room_id, due.message_number
        FROM due JOIN desktop_push_devices AS device ON device.account_id = due.account_id AND device.enabled
        ON CONFLICT (device_id, reminder_id) DO NOTHING
      )
      SELECT count(*)::int AS due FROM due
    `);
    await client.query("COMMIT");
    return result.rows[0]?.due ?? 0;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
