import { and, eq, inArray, sql } from 'drizzle-orm';
import { formatAttentionResponse, reviseKnowledgeRecord, RoomKnowledgeError, type KnowledgeActor, type KnowledgeRecord } from '../../../shared/room-knowledge.mjs';
import { db } from '../db/client.js';
import * as knowledgeStore from '../db/room-knowledge.js';
import { task_leases } from '../db/schema.js';
import { emitProjectMessage } from '../server/events.js';

export interface AttentionAnswerDeps {
  store?: Pick<typeof knowledgeStore, 'listRoomKnowledge' | 'getRoomKnowledge' | 'assertKnowledgeSource' | 'reviseRoomKnowledgeInTransaction'>;
  emitMessage?: typeof emitProjectMessage;
  /** Which of these leases are still held in the room. */
  heldLeaseIds?: (roomId: string, leaseIds: string[]) => Promise<string[]>;
}

// A lease id wherever it appears, including inside a longer token such as
// `lease_tl_…`. Reading too much is harmless: only a released id answers.
const LEASE_ID = /tl_[0-9a-f]{32}(?![0-9a-f])/g;

async function heldLeaseIds(roomId: string, leaseIds: string[]): Promise<string[]> {
  if (leaseIds.length === 0) return [];
  const rows = await db.select({ id: task_leases.id }).from(task_leases).where(and(
    eq(task_leases.room_id, roomId),
    inArray(task_leases.id, leaseIds),
    eq(task_leases.status, 'active'),
    sql`(${task_leases.expires_at} IS NULL OR ${task_leases.expires_at} > NOW())`,
  ));
  return rows.map(row => row.id);
}

/**
 * Record a person's answer to an open request. The answer is posted to the
 * room in the same transaction that records it, addressed to the agent that
 * asked, so the agent hears it. Returns the committed record.
 */
export async function commitAttentionAnswer(
  roomId: string,
  previous: KnowledgeRecord,
  next: KnowledgeRecord,
  person: KnowledgeActor,
  deps: AttentionAnswerDeps = {},
): Promise<KnowledgeRecord> {
  const store = deps.store ?? knowledgeStore;
  const publish = deps.emitMessage ?? emitProjectMessage;
  await publish(roomId, person.label, formatAttentionResponse(next), {
    source: 'browser', reply_to: previous.source_message_id || null,
    client_message_id: `internal:attention-response:${previous.id}`,
    account_id: person.id,
    with_created_message_in_transaction: tx => store.reviseRoomKnowledgeInTransaction(tx, next, previous.version),
  });
  const committed = await store.getRoomKnowledge(roomId, previous.id);
  if (committed?.version !== next.version || committed.response?.body !== next.response?.body || committed.response?.actor.id !== person.id) {
    throw new RoomKnowledgeError('The response could not be committed. Refresh and retry.', 409);
  }
  return committed;
}

/**
 * An agent that cannot clear a lease asks a person to, naming the lease. When
 * a person clears it, that is the answer: each open request in the room that
 * names the lease is answered for them, and the agent that asked is told. A
 * request that names other leases too stays open until none of them is held.
 *
 * Best effort. The lease is already released; a request that cannot be
 * answered stays open for the person to answer. Returns the ids answered.
 */
export async function answerRequestsNamingLease(
  input: { room_id: string; lease_id: string; response: string; person: KnowledgeActor },
  deps: AttentionAnswerDeps = {},
): Promise<string[]> {
  const store = deps.store ?? knowledgeStore;
  const answered: string[] = [];
  try {
    const { records } = await store.listRoomKnowledge(input.room_id, 'attention');
    for (const record of records) {
      if (record.response || record.archived) continue;
      const named = new Set([record.title, record.body, record.recommendation, record.unblocks].join('\n').match(LEASE_ID) ?? []);
      if (!named.delete(input.lease_id)) continue;
      try {
        if ((await (deps.heldLeaseIds ?? heldLeaseIds)(input.room_id, [...named])).length > 0) continue;
        const next = reviseKnowledgeRecord(record, { expected_version: record.version, response: input.response }, input.person);
        await store.assertKnowledgeSource(input.room_id, next.source_message_id);
        await commitAttentionAnswer(input.room_id, record, next, input.person, deps);
        answered.push(record.id);
      } catch (error) {
        console.warn(`[room knowledge] Could not answer ${record.id} for released lease ${input.lease_id}:`, error);
      }
    }
  } catch (error) {
    console.warn(`[room knowledge] Could not read requests naming released lease ${input.lease_id}:`, error);
  }
  return answered;
}
