import { and, eq, inArray, sql } from 'drizzle-orm';
import { formatAttentionRequest, formatAttentionResponse, reviseKnowledgeRecord, RoomKnowledgeError, type KnowledgeActor, type KnowledgeRecord } from '../../../shared/room-knowledge.mjs';
import { getActiveRoomAgentSessionsForWorkerIdentity } from '../db/auth/room-agent-sessions.js';
import { db } from '../db/client.js';
import * as knowledgeStore from '../db/room-knowledge.js';
import { accounts, task_leases } from '../db/schema.js';
import { emitProjectMessage } from '../server/events.js';

export interface AttentionAnswerDeps {
  store?: Pick<typeof knowledgeStore, 'listRoomKnowledge' | 'getRoomKnowledge' | 'assertKnowledgeSource' | 'reviseRoomKnowledgeInTransaction'>;
  emitMessage?: typeof emitProjectMessage;
  /** Which of these leases are still held in the room. */
  heldLeaseIds?: (roomId: string, leaseIds: string[]) => Promise<string[]>;
  /** Whether the agent still has a live session in the room. */
  agentStillPresent?: (roomId: string, agentKey: string) => Promise<boolean>;
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

export interface AttentionRequestDeps {
  store?: Pick<typeof knowledgeStore, 'getRoomKnowledge' | 'createRoomKnowledge' | 'createRoomKnowledgeInTransaction' | 'roomMessageIdForClientId'>;
  emitMessage?: typeof emitProjectMessage;
}

/** The worker that asks, as the room shows its messages. */
export interface AttentionRequestPublisher {
  agent_key: string;
  agent_session_id: string | null;
  owner_account_id?: string | null;
}

const requestNoticeClientId = (recordId: string) => `internal:attention-request:${recordId}`;

/**
 * Record an agent's new request and show it in the room, in one transaction.
 * A request without a source message takes the notice as its source, so the
 * answer replies to it. A retry with the same client ID posts nothing more:
 * it returns the saved request, or 409 when the content differs.
 */
export async function commitAttentionRequest(
  roomId: string,
  record: KnowledgeRecord,
  publisher: AttentionRequestPublisher,
  deps: AttentionRequestDeps = {},
): Promise<KnowledgeRecord> {
  const store = deps.store ?? knowledgeStore;
  const publish = deps.emitMessage ?? emitProjectMessage;
  const clientMessageId = requestNoticeClientId(record.id);
  // The notice the saved request may have taken as its source.
  const replay = (noticeId: string | null) => store.createRoomKnowledge(
    record.source_message_id || !noticeId ? record : { ...record, source_message_id: noticeId });
  // Requests saved before notices existed have none, and must not get one now.
  if (await store.getRoomKnowledge(roomId, record.id)) {
    return replay(record.source_message_id ? null : await store.roomMessageIdForClientId(roomId, clientMessageId));
  }
  let created: KnowledgeRecord | null = null;
  const notice = await publish(roomId, record.author.label, formatAttentionRequest(record), {
    source: 'agent',
    client_message_id: clientMessageId,
    publisher_agent_key: publisher.agent_key,
    publisher_agent_session_id: publisher.agent_session_id,
    account_id: publisher.owner_account_id ?? null,
    with_created_message_in_transaction: async (tx, message) => {
      const saved = record.source_message_id ? record : { ...record, source_message_id: `msg_${message.number}` };
      await store.createRoomKnowledgeInTransaction(tx, saved);
      created = saved;
    },
  });
  // No callback ran: a concurrent attempt saved the notice and its request.
  return created ?? replay(notice.id);
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

/** What a request an agent's owner retired records as its response. */
export const AGENT_RETIRED_RESPONSE = 'Agent retired.';

/** The account as the person who closes requests, or null when it is gone. */
export async function accountKnowledgeActor(accountId: string): Promise<KnowledgeActor | null> {
  const [row] = await db.select({ login: accounts.login }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return row ? { id: accountId, label: row.login, kind: 'human' } : null;
}

async function agentStillPresent(roomId: string, agentKey: string): Promise<boolean> {
  return (await getActiveRoomAgentSessionsForWorkerIdentity({ room_id: roomId, agent_key: agentKey })).length > 0;
}

/**
 * An agent its owner retires will not read answers. Each open request it
 * made in the room, by its agent key or by the ended session's id, is closed
 * for the person who retired it, and the agent is told in the room like any
 * answer. An agent with another live session in the room is still here and
 * keeps its requests.
 *
 * Best effort, like answerRequestsNamingLease: a request that cannot be
 * closed stays open for a person. Returns the ids closed.
 */
export async function closeRequestsOfRetiredAgent(
  input: { room_id: string; agent_key: string; session_id: string; person: KnowledgeActor },
  deps: AttentionAnswerDeps = {},
): Promise<string[]> {
  const store = deps.store ?? knowledgeStore;
  const authors = new Set([input.agent_key, input.session_id].filter(Boolean));
  const closed: string[] = [];
  try {
    if (await (deps.agentStillPresent ?? agentStillPresent)(input.room_id, input.agent_key)) return closed;
    const { records } = await store.listRoomKnowledge(input.room_id, 'attention');
    for (const record of records) {
      if (record.response || record.archived || record.author.kind !== 'agent' || !authors.has(record.author.id)) continue;
      try {
        const next = reviseKnowledgeRecord(record, { expected_version: record.version, close: true, response: AGENT_RETIRED_RESPONSE }, input.person);
        await store.assertKnowledgeSource(input.room_id, next.source_message_id);
        await commitAttentionAnswer(input.room_id, record, next, input.person, deps);
        closed.push(record.id);
      } catch (error) {
        console.warn(`[room knowledge] Could not close ${record.id} for a retired agent:`, error);
      }
    }
  } catch (error) {
    console.warn(`[room knowledge] Could not read requests of a retired agent in ${input.room_id}:`, error);
  }
  return closed;
}
