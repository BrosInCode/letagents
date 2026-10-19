import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeRecord, reviseKnowledgeRecord, type KnowledgeRecord } from '../../../shared/room-knowledge.mjs';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { answerRequestsNamingLease, closeRequestsOfRetiredAgent } = await import('../rooms/attention-answers.js');

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

test('retiring an agent closes only its own open requests, and tells it in the room', async () => {
  const other = { id: 'owner/river-stone', label: 'RiverStone', kind: 'agent' as const };
  const ask = (id: string, author: typeof agent | typeof person) => createKnowledgeRecord(room, 'attention', { client_id: id, category: 'question', title: 'Which port?', body: 'Pick one.' }, author);
  const records = new Map<string, KnowledgeRecord>([
    ['field-open-1', ask('field-open-1', agent)],
    ['field-open-2', ask('field-open-2', agent)],
    ['field-answered', reviseKnowledgeRecord(ask('field-answered', agent), { expected_version: 1, response: 'Port 80.' }, person)],
    // A local MCP request carries the session id when the agent has no canonical key.
    ['field-session', ask('field-session', { ...agent, id: 'session-field-1' })],
    ['river-open', ask('river-open', other)],
    ['person-open', ask('person-open', { ...person, id: agent.id })],
  ]);
  const posted: Array<{ sender: string; text: string; options: Record<string, unknown> | undefined }> = [];
  const retire = (stillPresent: boolean) => closeRequestsOfRetiredAgent({ room_id: room, agent_key: agent.id, session_id: 'session-field-1', person }, {
    agentStillPresent: async (_room, key) => { assert.equal(key, agent.id); return stillPresent; },
    store: {
      listRoomKnowledge: async () => ({ records: [...records.values()], truncated: false }),
      getRoomKnowledge: async (_room, id) => records.get(id) ?? null,
      assertKnowledgeSource: async () => {},
      reviseRoomKnowledgeInTransaction: async (_tx, next) => { records.set(next.id, next); },
    },
    emitMessage: async (_room, sender, text, options) => {
      posted.push({ sender, text, options: options as Record<string, unknown> | undefined });
      await options?.with_created_message_in_transaction?.({} as never, { number: posted.length } as never);
      return {} as never;
    },
  });
  assert.deepEqual(await retire(true), [], 'an agent with another live session in the room keeps its requests');
  assert.equal(posted.length, 0);
  const closed = await retire(false);
  assert.deepEqual(closed.sort(), ['field-open-1', 'field-open-2', 'field-session']);
  for (const id of closed) {
    assert.deepEqual(records.get(id)!.response, { body: 'Agent retired.', actor: person, at: records.get(id)!.response!.at, closed: true });
  }
  assert.equal(records.get('field-answered')!.response!.body, 'Port 80.', 'an answered request keeps its answer');
  assert.equal(records.get('river-open')!.response, null, 'another agent keeps its requests');
  assert.equal(records.get('person-open')!.response, null, 'only agent requests are closed');
  assert.equal(posted.length, 3);
  assert.ok(posted.every(message => message.sender === person.label && message.text.endsWith('\n\nAgent retired.')));
  assert.match(posted[0].text, /^@agent:owner\/field-trail\n\nHuman response \(field-open-1\):/);
});
