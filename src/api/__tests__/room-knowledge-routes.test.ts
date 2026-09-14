import assert from 'node:assert/strict';
import test from 'node:test';
import type { Express } from 'express';
import { createKnowledgeRecord, reviseKnowledgeRecord, type KnowledgeRecord } from '../../../shared/room-knowledge.mjs';
import { requiredAgentSessionRouteCapability } from '../request/agent-session-route-capabilities.js';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { registerRoomKnowledgeRoutes } = await import('../routes/rooms/knowledge.js');
const actor = { id: 'human-1', label: 'Emmy', kind: 'human' as const };
const worker = { id: 'owner/worker-b', label: 'Worker B', kind: 'agent' as const };
const input = { client_id: 'request-0001', category: 'decision' as const, title: 'Choose a direction', body: 'Option A or B?' };

function harness(options: { skipPublish?: boolean; denied?: boolean } = {}) {
  const routes: Array<{ method: string; path: RegExp; handler: Function }> = [];
  let record: KnowledgeRecord = createKnowledgeRecord('github.com/org/repo', 'attention', input, worker);
  let reads = 0; let published = 0;
  const app = Object.fromEntries(['get', 'post', 'patch'].map(method => [method, (path: RegExp, handler: Function) => routes.push({ method, path, handler })])) as unknown as Express;
  registerRoomKnowledgeRoutes(app, {
    resolveCanonicalRoomRequestId: async id => id,
    resolveRoomOrReply: async id => ({ id } as any),
    requireParticipant: async (_req, res) => { if (options.denied) { res.status(403).json({ error: 'Forbidden' }); return false; } return true; },
    getTasks: async () => [],
    store: {
      listRoomKnowledge: async () => { reads++; return { records: [record], truncated: false }; },
      getRoomKnowledge: async () => { reads++; return record; },
      assertKnowledgeSource: async () => {},
      reviseRoomKnowledgeInTransaction: async (_tx, next, version) => { assert.equal(record.version, version); record = next; },
      reviseRoomKnowledge: async next => { record = next; return next; },
      createRoomKnowledge: async next => { record = next; return next; },
      roomKnowledgeHistory: async () => [record],
    },
    emitMessage: async (_room, _sender, _text, opts) => { published++; if (!options.skipPublish) await opts?.with_created_message_in_transaction?.({} as any); return {} as any; },
  });
  async function request(method: string, path: string, body: any = {}, auth: string | null = 'session') {
    const route = routes.find(route => route.method === method && route.path.test(path))!;
    const matches = path.match(route.path)!;
    const req = { params: Object.fromEntries(matches.slice(1).map((value, i) => [i, value])), body, authKind: auth, sessionAccount: auth === 'session' || auth === 'owner_token' ? { account_id: actor.id, login: actor.label } : null, headers: {} };
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    await route.handler(req, res); return res;
  }
  return { request, current: () => record, set: (value: KnowledgeRecord) => { record = value; }, counts: () => ({ reads, published }) };
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
