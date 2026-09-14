import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createKnowledgeRecord, reviseKnowledgeRecord } from '../../../shared/room-knowledge.mjs';

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import('../db/client.js') : null;
const store = url ? await import('../db/room-knowledge.js') : null;
const messages = url ? await import('../db.js') : null;
const events = url ? await import('../server/events.js') : null;
const agent = { id: 'owner/worker-b', label: 'Worker B', kind: 'agent' as const };
const human = { id: 'human-1', label: 'Emmy', kind: 'human' as const };
const input = { client_id: 'record-0001', category: 'decision' as const, title: 'Keep the API', body: 'Preserve v2.' };
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve('drizzle') }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? 'Set TEST_DB_URL to run PostgreSQL integration tests.' : false };
test('PostgreSQL stores revisions, rejects stale writes, and deduplicates creation', options, async () => {
  const room = await messages!.createProjectWithName(`memory-${Date.now()}`);
  const old = await store!.createRoomKnowledge(createKnowledgeRecord(room.id, 'memory', input, agent));
  const result = await Promise.allSettled([
    store!.reviseRoomKnowledge(reviseKnowledgeRecord(old, { ...input, body: 'A', expected_version: 1 }, human), 1),
    store!.reviseRoomKnowledge(reviseKnowledgeRecord(old, { ...input, body: 'B', expected_version: 1 }, human), 1),
  ]);
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(result.filter(row => row.status === 'rejected').length, 1);
  assert.deepEqual((await store!.roomKnowledgeHistory(room.id, old.id)).map(row => row.version), [2, 1]);
  assert.equal((await store!.createRoomKnowledge(createKnowledgeRecord(room.id, 'memory', input, agent))).version, 2);
  await assert.rejects(store!.createRoomKnowledge(createKnowledgeRecord(room.id, 'memory', { ...input, body: 'wrong reuse' }, agent)), /already used/);
  assert.equal(await store!.getRoomKnowledge('another-room', old.id), null);
});
test('a response and its chat message commit atomically and roll back together', options, async () => {
  const room = await messages!.createProjectWithName(`attention-${Date.now()}`);
  const old = await store!.createRoomKnowledge(createKnowledgeRecord(room.id, 'attention', input, agent));
  const answer = reviseKnowledgeRecord(old, { expected_version: 1, response: 'Approved with v2 unchanged.' }, human);
  await assert.rejects(events!.emitProjectMessage(room.id, 'Emmy', 'Failed answer', {
    source: 'browser', client_message_id: 'attention-test-fail',
    with_created_message_in_transaction: async tx => { await store!.reviseRoomKnowledgeInTransaction(tx, answer, 1); throw new Error('Simulated failure'); },
  }), /Simulated failure/);
  assert.equal((await store!.getRoomKnowledge(room.id, old.id))!.response, null);
  assert.equal((await messages!.getMessages(room.id)).messages.length, 0);
  await events!.emitProjectMessage(room.id, 'Emmy', answer.response!.body, {
    source: 'browser', client_message_id: 'attention-test-success',
    with_created_message_in_transaction: tx => store!.reviseRoomKnowledgeInTransaction(tx, answer, 1),
  });
  assert.equal((await store!.getRoomKnowledge(room.id, old.id))!.response!.body, answer.response!.body);
  assert.equal((await messages!.getMessages(room.id)).messages.length, 1);
  await assert.rejects(store!.assertKnowledgeSource(room.id, 'msg_99999'), /does not exist/);
  const hidden = await messages!.addMessage(room.id, 'system', '', { agent_prompt_kind: 'auto' });
  await assert.rejects(store!.assertKnowledgeSource(room.id, hidden.id), /does not exist/);
});
