import assert from 'node:assert/strict';
import test from 'node:test';
import type { Express } from 'express';
import { assertKnowledgeReplay, createKnowledgeRecord, reviseKnowledgeRecord, RoomKnowledgeError, type KnowledgeRecord } from '../../../shared/room-knowledge.mjs';
import { requiredAgentSessionRouteCapability } from '../request/agent-session-route-capabilities.js';
import { parseCreateMessageBody } from '../messages/inputs.js';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { registerRoomKnowledgeRoutes } = await import('../routes/rooms/knowledge.js');
const actor = { id: 'human-1', label: 'Emmy', kind: 'human' as const };
const worker = { id: 'owner/worker-b', label: 'Worker B', kind: 'agent' as const };
const input = { client_id: 'request-0001', category: 'decision' as const, title: 'Choose a direction', body: 'Option A or B?' };

function harness(options: { skipPublish?: boolean; denied?: boolean; empty?: boolean } = {}) {
  const routes: Array<{ method: string; path: RegExp; handler: Function }> = [];
  let record: KnowledgeRecord | null = options.empty ? null : createKnowledgeRecord('github.com/org/repo', 'attention', input, worker);
  let initial = record;
  let reads = 0; let published = 0;
  // Room messages by client message id, deduplicated as the database does.
  const posted: Array<{ number: number; sender: string; text: string; opts: any }> = [];
  const app = Object.fromEntries(['get', 'post', 'patch'].map(method => [method, (path: RegExp, handler: Function) => routes.push({ method, path, handler })])) as unknown as Express;
  registerRoomKnowledgeRoutes(app, {
    resolveCanonicalRoomRequestId: async id => id,
    resolveRoomOrReply: async id => ({ id } as any),
    requireParticipant: async (_req, res) => { if (options.denied) { res.status(403).json({ error: 'Forbidden' }); return false; } return true; },
    getTasks: async () => [],
    store: {
      listRoomKnowledge: async () => { reads++; return { records: record ? [record] : [], truncated: false }; },
      getRoomKnowledge: async () => { reads++; return record; },
      assertKnowledgeSource: async () => {},
      reviseRoomKnowledgeInTransaction: async (_tx, next, version) => { assert.equal(record!.version, version); record = next; },
      reviseRoomKnowledge: async next => { record = next; return next; },
      createRoomKnowledge: async next => { if (record) { assertKnowledgeReplay(initial!, next); return record; } record = initial = next; return next; },
      createRoomKnowledgeInTransaction: async (_tx, next) => { if (record) throw new RoomKnowledgeError('Retry.', 409); record = initial = next; },
      roomMessageIdForClientId: async (_room, id) => { const found = posted.find(message => message.opts?.client_message_id === id); return found ? `msg_${found.number}` : null; },
      roomKnowledgeHistory: async () => [record!],
    } as any,
    emitMessage: async (_room, sender, text, opts) => {
      assert.throws(() => parseCreateMessageBody({ client_message_id: opts?.client_message_id }), /reserved namespace/);
      published++;
      const existing = posted.find(message => message.opts?.client_message_id === opts?.client_message_id);
      if (existing) return { id: `msg_${existing.number}` } as any;
      const number = 40 + posted.length + 1;
      if (!options.skipPublish) await opts?.with_created_message_in_transaction?.({} as any, { number } as any);
      posted.push({ number, sender, text, opts });
      return { id: `msg_${number}` } as any;
    },
  });
  async function request(method: string, path: string, body: any = {}, auth: string | null = 'session') {
    const route = routes.find(route => route.method === method && route.path.test(path))!;
    const matches = path.match(route.path)!;
    // A worker bearer is the agent that asks, scoped to this room.
    const agentSession = auth === 'agent_session' ? { room_id: 'github.com/org/repo', actor_label: worker.label, agent_key: worker.id, owner_account_id: 'owner-1',
      agent_session_id: 'session-b', agent_instance_id: null, session_kind: 'worker', runtime: 'codex', display_name: 'Worker B', owner_label: 'Owner', ide_label: 'Codex', repo_branch: null } : undefined;
    const req = { params: Object.fromEntries(matches.slice(1).map((value, i) => [i, value])), body, authKind: auth, agentSession, sessionAccount: auth === 'session' || auth === 'owner_token' ? { account_id: actor.id, login: actor.label } : null, headers: {} };
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    await route.handler(req, res); return res;
  }
  return { request, current: () => record!, set: (value: KnowledgeRecord) => { record = value; }, counts: () => ({ reads, published }), posted };
}
const route = '/rooms/github.com/org/repo/attention/request-0001/respond';
test('worker routes allow proposal/read only, never human response or memory correction', () => {
  for (const type of ['memory', 'attention']) {
    assert.equal(requiredAgentSessionRouteCapability('GET', `/rooms/github.com/org/repo/${type}`), 'coordination.read');
    assert.equal(requiredAgentSessionRouteCapability('POST', `/rooms/github.com/org/repo/${type}`), 'coordination.propose');
  }
  assert.equal(requiredAgentSessionRouteCapability('POST', route), null);
  assert.equal(requiredAgentSessionRouteCapability('PATCH', '/rooms/github.com/org/repo/memory/record-0001'), null);
});
test('a denied room cannot disclose memory, requests or tasks', async () => {
  const h = harness({ denied: true });
  assert.equal((await h.request('get', '/rooms/github.com/org/repo/memory')).code, 403);
  assert.equal((await h.request('post', route, { expected_version: 1, response: 'A' })).code, 403);
  assert.deepEqual(h.counts(), { reads: 0, published: 0 });
});
test('anonymous/worker/ordinary owner tokens cannot answer as a human', async () => {
  for (const auth of [null, 'agent_session', 'owner_token']) {
    const h = harness(); const res = await h.request('post', route, { expected_version: 1, response: 'A' }, auth);
    assert.equal(res.code, 403); assert.equal(h.current().version, 1);
  }
});
test('successful responses are canonical, durable and retry-safe', async () => {
  const h = harness();
  const response = await h.request('post', route, { expected_version: 1, response: 'Option A.' });
  assert.equal(response.code, 200); assert.deepEqual(response.body.record, h.current());
  assert.equal(h.current().response?.actor.id, actor.id);
  assert.equal((await h.request('post', route, { expected_version: 1, response: 'Option A.' })).code, 200);
  assert.equal(h.counts().published, 1);
  assert.equal((await h.request('post', route, { expected_version: 1, response: 'Option B.' })).code, 409);
});
test('a duplicate message must not falsely acknowledge an uncommitted or losing answer', async () => {
  const h = harness({ skipPublish: true });
  const response = await h.request('post', route, { expected_version: 1, response: 'My answer' });
  assert.equal(response.code, 409); assert.equal(h.current().response, null);
  h.set(reviseKnowledgeRecord(h.current(), { expected_version: 1, response: 'Winner' }, actor));
  assert.equal((await h.request('post', route, { expected_version: 1, response: 'Loser' })).code, 409);
  assert.equal(h.current().response?.body, 'Winner');
});

const create = '/rooms/github.com/org/repo/attention';
const close = '/rooms/github.com/org/repo/attention/request-0001/close';
test('an agent request is posted to its room once, and the notice becomes its source', async () => {
  const h = harness({ empty: true });
  const created = await h.request('post', create, input, 'agent_session');
  assert.equal(created.code, 201);
  assert.equal(h.posted.length, 1);
  const [notice] = h.posted;
  assert.equal(notice.sender, worker.label);
  assert.equal(notice.text, 'Needs you · Decision: Choose a direction\n\nOption A or B?\n\nWaiting for an answer in Inbox (request-0001).');
  assert.deepEqual({ source: notice.opts.source, client_message_id: notice.opts.client_message_id, publisher_agent_key: notice.opts.publisher_agent_key,
    publisher_agent_session_id: notice.opts.publisher_agent_session_id, account_id: notice.opts.account_id },
  { source: 'agent', client_message_id: 'internal:attention-request:request-0001', publisher_agent_key: worker.id, publisher_agent_session_id: 'session-b', account_id: 'owner-1' });
  assert.equal(created.body.record.source_message_id, `msg_${notice.number}`, 'the answer replies to the notice');
  assert.deepEqual(created.body.record, h.current());
  // A retry after a lost response posts nothing more and returns the saved request.
  const replay = await h.request('post', create, input, 'agent_session');
  assert.equal(replay.code, 201); assert.deepEqual(replay.body.record, h.current());
  assert.equal(h.posted.length, 1);
  assert.equal((await h.request('post', create, { ...input, body: 'Something else' }, 'agent_session')).code, 409);
  assert.equal(h.posted.length, 1);
});
test('a request that names its source keeps it, and a request saved before notices gets none on retry', async () => {
  const sourced = harness({ empty: true });
  const created = await sourced.request('post', create, { ...input, source_message_id: 'msg_3' }, 'agent_session');
  assert.equal(created.code, 201); assert.equal(created.body.record.source_message_id, 'msg_3');
  assert.equal((await sourced.request('post', create, { ...input, source_message_id: 'msg_3' }, 'agent_session')).code, 201);
  assert.equal(sourced.posted.length, 1);
  const legacy = harness();
  const replay = await legacy.request('post', create, input, 'agent_session');
  assert.equal(replay.code, 201); assert.equal(replay.body.record.source_message_id, '');
  assert.equal(legacy.counts().published, 0);
});
test('a request a person files is saved without a room notice', async () => {
  const h = harness({ empty: true });
  assert.equal((await h.request('post', create, input)).code, 201);
  assert.equal(h.counts().published, 0);
});
test('only a signed-in human can close a request, once, and the agent that asked is told', async () => {
  assert.equal(requiredAgentSessionRouteCapability('POST', close), null);
  for (const auth of [null, 'agent_session', 'owner_token']) {
    const h = harness(); assert.equal((await h.request('post', close, { expected_version: 1 }, auth)).code, 403); assert.equal(h.current().response, null);
  }
  const h = harness();
  const closed = await h.request('post', close, { expected_version: 1, response: 'Draft text is not sent.' });
  assert.equal(closed.code, 200); assert.deepEqual(closed.body.record, h.current());
  assert.deepEqual(h.current().response, { body: 'Closed without an answer.', actor, at: h.current().response!.at, closed: true });
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].text, '@agent:owner/worker-b\n\nHuman response (request-0001):\n\nClosed without an answer.');
  assert.equal(h.posted[0].opts.client_message_id, 'internal:attention-response:request-0001');
  assert.equal((await h.request('post', close, { expected_version: 1 })).code, 200, 'a retry after a lost response is harmless');
  assert.equal(h.counts().published, 1);
  assert.equal((await h.request('post', close, { expected_version: 2 })).code, 409);
  assert.equal((await h.request('post', route, { expected_version: 2, response: 'Late answer' })).code, 409);
  assert.equal(h.counts().published, 1);
});
