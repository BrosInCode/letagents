import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeRecord, type KnowledgeRecord } from '../../../shared/room-knowledge.mjs';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { answerRequestsNamingLease } = await import('../rooms/attention-answers.js');

const room = 'github.com/org/repo';
const agent = { id: 'owner/field-trail', label: 'FieldTrail', kind: 'agent' as const };
const person = { id: 'account-1', label: 'Owner', kind: 'human' as const };
const released = `tl_${'a'.repeat(32)}`;
const other = `tl_${'b'.repeat(32)}`;

function harness(bodies: Record<string, string>, held: string[] = []) {
  const records = new Map<string, KnowledgeRecord>(Object.entries(bodies).map(([id, body]) =>
    [id, createKnowledgeRecord(room, 'attention', { client_id: id, category: 'approval', title: 'Room admin needed', body }, agent)]));
  const answered = answerRequestsNamingLease({ room_id: room, lease_id: released, response: 'Released.', person }, {
    store: {
      listRoomKnowledge: async () => ({ records: [...records.values()], truncated: false }),
      getRoomKnowledge: async (_room, id) => records.get(id) ?? null,
      assertKnowledgeSource: async () => {},
      reviseRoomKnowledgeInTransaction: async (_tx, next) => { records.set(next.id, next); },
    },
    emitMessage: async (_room, _sender, _text, options) => {
      await options?.with_created_message_in_transaction?.({} as never);
      return {} as never;
    },
    heldLeaseIds: async (_room, ids) => ids.filter(id => held.includes(id)),
  });
  return { answered, response: (id: string) => records.get(id)?.response?.body ?? null };
}

test('a request is answered when the lease it names is released, however the id is written into it', async () => {
  const h = harness({
    'request-plain-id': `Release ${released}, please.`,
    'request-prefixed': `Stale reviewer lease_${released} on task_6.`,
    'request-unrelated': `Release ${other}.`,
    'request-longer-id': `Not a lease: ${released}ff.`,
  });
  assert.deepEqual((await h.answered).sort(), ['request-plain-id', 'request-prefixed']);
  assert.equal(h.response('request-plain-id'), 'Released.');
  assert.equal(h.response('request-unrelated'), null);
  assert.equal(h.response('request-longer-id'), null);
});

test('a request naming another lease still held stays open until that one is released too', async () => {
  const both = { 'request-both': `Release ${released} and ${other}.` };
  const stillHeld = harness(both, [other]);
  assert.deepEqual(await stillHeld.answered, []);
  assert.equal(stillHeld.response('request-both'), null);
  const bothReleased = harness(both, []);
  assert.deepEqual(await bothReleased.answered, ['request-both']);
});
