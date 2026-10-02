import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { MESSAGE_SEARCH_DEFAULT_LIMIT, MESSAGE_SEARCH_MAX_LIMIT } from '../../../shared/message-search.mjs';

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import('../db/client.js') : null;
const rooms = url ? await import('../db.js') : null;
const store = url ? await import('../db/messages/search.js') : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve('drizzle') }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? 'Set TEST_DB_URL to run PostgreSQL integration tests.' : false };
let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;

async function roomWith(texts: string[]) {
  const room = await rooms!.createProjectWithName(unique('search'));
  const ids: string[] = [];
  for (const text of texts) ids.push((await rooms!.addMessage(room.id, 'Emmy', text, { source: 'browser' })).id);
  return { room, ids };
}
const found = async (roomId: string, terms: string[], extra: object = {}) =>
  (await store!.searchRoomMessages(roomId, terms, extra)).messages.map((message) => message.id);

test('a message is found by any part of its text, ignoring case, newest first', options, async () => {
  const { room, ids } = await roomWith([
    'The worker mint had no lock_timeout.',
    'See useDesktopRoomMessages in the renderer.',
    'Unrelated chatter.',
    'LOCK_TIMEOUT is now 3s for the Mint transaction.',
  ]);
  assert.deepEqual(await found(room.id, ['lock_timeout']), [ids[3], ids[0]]);
  assert.deepEqual(await found(room.id, ['RoomMess']), [ids[1]], 'part of an identifier');
  assert.deepEqual(await found(room.id, ['mint', 'transaction']), [ids[3]], 'every term must be present');
  assert.deepEqual(await found(room.id, ['mint tr']), [ids[3]], 'a phrase matches across a space');
  assert.deepEqual(await found(room.id, ['nothing like this']), []);
  assert.deepEqual(await found(room.id, []), []);
});

test('wildcard and escape characters in a term are ordinary text', options, async () => {
  const { room, ids } = await roomWith(['coverage is 100% now', 'coverage is 1000 now', 'a_b', 'axb', 'path C:\\temp\\x', 'C:tempx']);
  assert.deepEqual(await found(room.id, ['100%']), [ids[0]]);
  assert.deepEqual(await found(room.id, ['a_b']), [ids[2]]);
  assert.deepEqual(await found(room.id, ['C:\\temp']), [ids[4]]);
  assert.deepEqual(await found(room.id, ['%']), [ids[0]]);
});

test('search stays inside its room', options, async () => {
  const first = await roomWith(['the needle is here']);
  const second = await roomWith(['another needle']);
  assert.deepEqual(await found(first.room.id, ['needle']), first.ids);
  assert.deepEqual(await found(second.room.id, ['needle']), second.ids);
});

test('the readable copy of a system message is searched; an empty prompt is never found', options, async () => {
  const room = await rooms!.createProjectWithName(unique('search-system'));
  const system = await rooms!.addMessage(room.id, 'letagents', '@agent:owner/lumen Board intent bi_1 was approved.', {
    source: 'system',
    display_text: '@LumenRiver — Your request to claim the search task was approved.',
  });
  await rooms!.addMessage(room.id, 'Agent', '', { source: 'agent', agent_prompt_kind: 'auto' });
  assert.deepEqual(await found(room.id, ['claim the search task']), [system.id], 'found by what people read');
  assert.deepEqual(await found(room.id, ['bi_1']), [system.id], 'and by the canonical text');
  assert.deepEqual(await found(room.id, ['agent']), [system.id], 'the empty prompt from "Agent" is not a result');
});

test('results page backwards from a cursor and carry everything a message row needs', options, async () => {
  const texts = Array.from({ length: 7 }, (_, index) => `hit number ${index}`);
  const { room, ids } = await roomWith(texts);
  const firstPage = await store!.searchRoomMessages(room.id, ['hit'], { limit: 3 });
  assert.deepEqual(firstPage.messages.map((message) => message.id), [ids[6], ids[5], ids[4]]);
  assert.deepEqual([firstPage.has_more, firstPage.next_before], [true, ids[4]]);
  const secondPage = await store!.searchRoomMessages(room.id, ['hit'], { limit: 3, before: Number(firstPage.next_before!.slice(4)) });
  assert.deepEqual(secondPage.messages.map((message) => message.id), [ids[3], ids[2], ids[1]]);
  const lastPage = await store!.searchRoomMessages(room.id, ['hit'], { limit: 3, before: Number(secondPage.next_before!.slice(4)) });
  assert.deepEqual(lastPage.messages.map((message) => message.id), [ids[0]]);
  assert.deepEqual([lastPage.has_more, lastPage.next_before], [false, null]);

  const [message] = firstPage.messages;
  assert.equal(message!.text, 'hit number 6');
  assert.equal(message!.sender, 'Emmy');
  assert.deepEqual(message!.attachments, []);
  assert.equal(message!.thread_root_id, ids[6]);
});

test('the page size has a default and a ceiling', options, async () => {
  const { room } = await roomWith(Array.from({ length: MESSAGE_SEARCH_MAX_LIMIT + 5 }, (_, index) => `bulk ${index}`));
  assert.equal((await store!.searchRoomMessages(room.id, ['bulk'])).messages.length, MESSAGE_SEARCH_DEFAULT_LIMIT);
  assert.equal((await store!.searchRoomMessages(room.id, ['bulk'], { limit: 10_000 })).messages.length, MESSAGE_SEARCH_MAX_LIMIT);
  assert.equal((await store!.searchRoomMessages(room.id, ['bulk'], { limit: -1 })).messages.length, MESSAGE_SEARCH_DEFAULT_LIMIT);
});

test('a thread reply is found and says which thread it belongs to', options, async () => {
  const room = await rooms!.createProjectWithName(unique('search-thread'));
  const root = await rooms!.addMessage(room.id, 'Emmy', 'Shall we ship?', { source: 'browser' });
  const reply = await rooms!.addMessage(room.id, 'Ada', 'Ship after the migration lands.', { source: 'browser', thread_root_message_id: root.id });
  const [hit] = (await store!.searchRoomMessages(room.id, ['migration lands'])).messages;
  assert.equal(hit!.id, reply.id);
  assert.equal(hit!.thread_root_id, root.id);
});


test('whitespace-only auto prompts are hidden even when their display text matches', options, async () => {
  const room = await rooms!.createProjectWithName(unique('search-hidden'));
  for (const text of ['', '   ', '\t\n', '\r\n', '\u00a0', '\u2003', '\ufeff']) {
    await rooms!.addMessage(room.id, 'Agent', text, {
      source: 'system', agent_prompt_kind: 'auto', display_text: 'private needle',
    });
  }
  assert.deepEqual(await found(room.id, ['needle']), []);
});


test('a blocked search times out in PostgreSQL and does not leak its local timeout', options, async () => {
  const { room } = await roomWith(['timeout needle']);
  const locker = await client!.pool.connect();
  try {
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE messages IN ACCESS EXCLUSIVE MODE');
    const started = Date.now();
    await assert.rejects(store!.searchRoomMessages(room.id, ['needle']), (error: any) =>
      (error.code ?? error.cause?.code) === '57014');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 3500 && elapsed < 10000, `timeout elapsed: ${elapsed}ms`);
    const { rows } = await client!.pool.query('SHOW statement_timeout');
    assert.equal(rows[0].statement_timeout, '0', 'SET LOCAL ends with the rolled-back transaction');
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
  }
  assert.equal((await store!.searchRoomMessages(room.id, ['needle'])).messages.length, 1);
});
