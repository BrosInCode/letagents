import { and, desc, eq, sql } from 'drizzle-orm';
import { visibleMessageCondition } from './messages/visibility.js';
import { db } from './client.js';
import { room_knowledge as records, room_knowledge_revisions as revisions, messages } from './schema.js';
import { assertKnowledgeReplay, RoomKnowledgeError, type KnowledgeRecord, type KnowledgeType } from '../../../shared/room-knowledge.mjs';
import type { MessageCreateTransaction } from './messages/create.js';

// Room-ID cascades update the relational keys, not the historical JSON payload.
function inRoom(roomId: string, value: KnowledgeRecord): KnowledgeRecord { return { ...value, room_id: roomId }; }

export async function listRoomKnowledge(roomId: string, type: KnowledgeType) {
  const rows = await db.select({ value: records.value }).from(records)
    .where(and(eq(records.room_id, roomId), eq(records.type, type)))
    .orderBy(sql`(${records.value}->>'archived')::boolean ASC`, sql`(${records.value}->'response' = 'null'::jsonb) DESC`, sql`${records.value}->>'updated_at' DESC`).limit(201);
  return { records: rows.slice(0, 200).map(row => inRoom(roomId, row.value)), truncated: rows.length > 200 };
}
export async function getRoomKnowledge(roomId: string, id: string) {
  const value = (await db.select().from(records).where(and(eq(records.room_id, roomId), eq(records.id, id))).limit(1))[0]?.value;
  return value ? inRoom(roomId, value) : null;
}
export async function roomKnowledgeHistory(roomId: string, id: string) {
  return (await db.select().from(revisions).where(and(eq(revisions.room_id, roomId), eq(revisions.id, id))).orderBy(desc(revisions.version)).limit(100)).map(row => inRoom(roomId, row.value));
}
export async function assertKnowledgeSource(roomId: string, source: string) {
  if (!source) return;
  const row = await db.select({ number: messages.number }).from(messages)
    .where(and(eq(messages.room_id, roomId), eq(messages.number, Number(source.slice(4))), visibleMessageCondition(false))).limit(1);
  if (!row.length) throw new RoomKnowledgeError('The source message does not exist in this room.');
}
export async function createRoomKnowledge(record: KnowledgeRecord) {
  return db.transaction(async tx => {
    const inserted = await tx.insert(records).values({ room_id: record.room_id, id: record.id, type: record.type, version: record.version, value: record }).onConflictDoNothing().returning();
    if (!inserted.length) {
      const initial = (await tx.select().from(revisions).where(and(eq(revisions.room_id, record.room_id), eq(revisions.id, record.id), eq(revisions.version, 1))))[0];
      if (!initial) throw new RoomKnowledgeError('This record is being created. Retry with the same client ID.', 409);
      assertKnowledgeReplay(inRoom(record.room_id, initial.value), record);
      return inRoom(record.room_id, (await tx.select().from(records).where(and(eq(records.room_id, record.room_id), eq(records.id, record.id))))[0].value);
    }
    await tx.insert(revisions).values({ room_id: record.room_id, id: record.id, version: record.version, value: record });
    return record;
  });
}
export async function reviseRoomKnowledgeInTransaction(tx: MessageCreateTransaction, record: KnowledgeRecord, expectedVersion: number) {
  const changed = await tx.update(records).set({ value: record, version: record.version })
    .where(and(eq(records.room_id, record.room_id), eq(records.id, record.id), eq(records.version, expectedVersion))).returning();
  if (!changed.length) throw new RoomKnowledgeError('This changed since you opened it. Refresh to see the latest version.', 409);
  await tx.insert(revisions).values({ room_id: record.room_id, id: record.id, version: record.version, value: record });
}
export async function reviseRoomKnowledge(record: KnowledgeRecord, expectedVersion: number) {
  await db.transaction(tx => reviseRoomKnowledgeInTransaction(tx, record, expectedVersion));
  return record;
}
